import type { calendarEvents } from "../db/schema"
import type { Via } from "./aiTypes"
import { DAY_MS, fromWallClock, isUtcMidnight, msToStored, parseInstant, storedMs, wallClock } from "./eventTime"
import { nextOccurrence, occursAt, seriesTimeZone, shiftUntil, splitSeries, type SeriesTiming } from "./recurrence"

/**
 * Turns an edit or delete of an event, an occurrence or a series into row operations, the way
 * Google Calendar's "This event", "This and following events" and "All events" behave. Guest
 * lists belong to each row, so an override keeps its own. Pure, the caller runs the plan.
 */

type EventRow = typeof calendarEvents.$inferSelect
type EventInsert = typeof calendarEvents.$inferInsert

type Scope = "this" | "following" | "all"
export type Guest = { userId: string; response: string }

export type EventChanges = {
  title?: string
  description?: string | null
  location?: string | null
  starts_at?: string
  ends_at?: string
  all_day?: boolean
  event_type?: string
  video_call?: boolean
  everyone?: boolean
  recurrence_rule?: string | null
  recurrence_tz?: string | null
  reminder_minutes?: number | null
  attendee_ids?: string[]
}

/** The row named by the request, its series master and every override of that master. */
export type SeriesState = {
  target: EventRow
  master: EventRow | null
  overrides: EventRow[]
  guests: Map<string, Guest[]>
  /** Rows of the target's Trash entry outside its family, such as an occurrence a split left with the earlier series */
  strays?: EventRow[]
}

export type Plan = {
  inserts: (EventInsert & { id: string })[]
  updates: { id: string; set: Partial<EventInsert> }[]
  deletes: string[]
  guestAdds: { eventId: string; userId: string; response: string }[]
  guestRemoves: { eventId: string; userId: string }[]
  resultId: string | null
}

type PlanContext = { now: string; newId: () => string }

export class PlanError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

const FIELDS = {
  title: "title",
  description: "description",
  location: "location",
  all_day: "allDay",
  event_type: "eventType",
  video_call: "videoCall",
  everyone: "everyone",
  recurrence_rule: "recurrenceRule",
  recurrence_tz: "recurrenceTz",
  reminder_minutes: "reminderMinutes",
} as const

type Fields = Pick<EventRow, (typeof FIELDS)[keyof typeof FIELDS]>
type FieldKey = keyof Fields

const FIELD_KEYS = Object.values(FIELDS) as FieldKey[]
/** Fields an "all events" change carries to an override that still had the series' value. */
const SHARED: FieldKey[] = ["title", "description", "location", "eventType", "videoCall", "everyone", "reminderMinutes"]

function fieldsOf(row: Fields): Fields {
  return Object.fromEntries(FIELD_KEYS.map((key) => [key, row[key]])) as Fields
}

function merge(row: Fields, changes: EventChanges): Fields {
  const out = fieldsOf(row) as Record<FieldKey, unknown>
  for (const [bodyKey, rowKey] of Object.entries(FIELDS)) {
    const value = changes[bodyKey as keyof typeof FIELDS]
    if (value !== undefined) out[rowKey] = value
  }
  return out as Fields
}

function changed(before: Fields, after: Fields, keys: FieldKey[] = FIELD_KEYS): Partial<Fields> {
  return Object.fromEntries(keys.filter((key) => before[key] !== after[key]).map((key) => [key, after[key]]))
}

const sameSecond = (a: number, b: number) => Math.floor(a / 1000) === Math.floor(b / 1000)
const dayOf = (wall: number) => Math.floor(wall / DAY_MS) * DAY_MS

function toMs(value: string | null): number {
  const ms = storedMs(value)
  if (ms === null) throw new PlanError(500, "The stored event has no valid time")
  return ms
}

function instantOf(iso: string): number {
  const ms = parseInstant(iso)
  if (ms === null) throw new PlanError(400, "Use an ISO 8601 time with Z or an offset")
  return ms
}

function checkEvent(start: number, end: number, fields: Fields) {
  if (end <= start) throw new PlanError(400, "End must be after start")
  if (fields.allDay && (!isUtcMidnight(start) || !isUtcMidnight(end))) {
    throw new PlanError(400, "All-day events start and end at 00:00 UTC")
  }
  if (fields.recurrenceRule && !fields.allDay && !fields.recurrenceTz) {
    throw new PlanError(400, "A repeating event needs the time zone it repeats in")
  }
}

function guestList(ids: string[], creatorId: string, known: Guest[]): Guest[] {
  const responses = new Map(known.map((guest) => [guest.userId, guest.response]))
  return [...new Set(ids)].filter((id) => id !== creatorId).map((userId) => ({ userId, response: responses.get(userId) ?? "pending" }))
}

class Builder {
  readonly plan: Plan = { inserts: [], updates: [], deletes: [], guestAdds: [], guestRemoves: [], resultId: null }

  constructor(
    readonly state: SeriesState,
    readonly ctx: PlanContext,
  ) {}

  guestsOf(id: string): Guest[] {
    return this.state.guests.get(id) ?? []
  }

  insert(row: EventInsert & { id: string }) {
    this.plan.inserts.push({ ...row, createdAt: this.ctx.now, updatedAt: this.ctx.now })
  }

  update(id: string, set: Partial<EventInsert>) {
    if (Object.keys(set).length === 0) return
    const existing = this.plan.updates.find((update) => update.id === id)
    if (existing) Object.assign(existing.set, set)
    else this.plan.updates.push({ id, set: { ...set, updatedAt: this.ctx.now } })
  }

  remove(id: string) {
    if (!this.plan.deletes.includes(id)) this.plan.deletes.push(id)
  }

  addGuests(eventId: string, guests: Guest[]) {
    for (const guest of guests) this.plan.guestAdds.push({ eventId, userId: guest.userId, response: guest.response })
  }

  setGuests(eventId: string, next: Guest[]) {
    const current = this.guestsOf(eventId)
    const keep = new Set(next.map((guest) => guest.userId))
    const have = new Set(current.map((guest) => guest.userId))
    for (const guest of current) if (!keep.has(guest.userId)) this.plan.guestRemoves.push({ eventId, userId: guest.userId })
    this.addGuests(
      eventId,
      next.filter((guest) => !have.has(guest.userId)),
    )
  }

  overrideAt(at: number): EventRow | undefined {
    return this.state.overrides.find((row) => sameSecond(toMs(row.originalStart), at))
  }
}

function requireOccurrence(master: EventRow, at: number) {
  if (!occursAt(master.recurrenceRule ?? "", msToStored(at), master)) {
    throw new PlanError(400, "The series has no occurrence at that time")
  }
}

function overrideRow(b: Builder, master: EventRow, fields: Fields, at: number, start: number, end: number) {
  return {
    ...fields,
    id: b.ctx.newId(),
    recurrenceRule: null,
    recurrenceTz: null,
    createdBy: master.createdBy,
    organizationId: master.organizationId,
    seriesId: master.id,
    originalStart: msToStored(at),
    cancelled: false,
    startsAt: msToStored(start),
    endsAt: msToStored(end),
  }
}

const ONE_OCCURRENCE = "One occurrence cannot repeat. Change this and following events or all events"

/** A form that resends the series' own rule with "This event" is not asking to change it. */
function sameRuleDropped(changes: EventChanges, master: EventRow): EventChanges {
  return changes.recurrence_rule === master.recurrenceRule ? { ...changes, recurrence_rule: undefined } : changes
}

/** A plain event, or an override as "This event". */
function editRow(b: Builder, row: EventRow, changes: EventChanges) {
  const isOverride = row.seriesId !== null
  if (isOverride && changes.recurrence_rule) throw new PlanError(400, ONE_OCCURRENCE)
  const fields = merge(row, isOverride ? { ...changes, recurrence_rule: undefined, recurrence_tz: undefined } : changes)
  const start = changes.starts_at !== undefined ? instantOf(changes.starts_at) : toMs(row.startsAt)
  const end = changes.ends_at !== undefined ? instantOf(changes.ends_at) : toMs(row.endsAt)
  checkEvent(start, end, fields)
  b.update(row.id, { ...changed(fieldsOf(row), fields), ...times(row, start, end) })
  if (changes.attendee_ids) b.setGuests(row.id, guestList(changes.attendee_ids, row.createdBy, b.guestsOf(row.id)))
  b.plan.resultId = row.id
}

function times(row: EventRow, start: number, end: number): Partial<EventInsert> {
  const set: Partial<EventInsert> = {}
  if (toMs(row.startsAt) !== start) set.startsAt = msToStored(start)
  if (toMs(row.endsAt) !== end) set.endsAt = msToStored(end)
  return set
}

/** "This event" on an occurrence of a series. */
function editOccurrence(b: Builder, changes: EventChanges, at: number) {
  const master = b.state.master!
  changes = sameRuleDropped(changes, master)
  if (changes.recurrence_rule) throw new PlanError(400, ONE_OCCURRENCE)
  const existing = b.overrideAt(at)
  if (existing?.cancelled) throw new PlanError(404, "That occurrence was deleted")
  if (existing) return editRow(b, existing, changes)
  const duration = toMs(master.endsAt) - toMs(master.startsAt)
  const fields = merge(master, { ...changes, recurrence_rule: null, recurrence_tz: null })
  const start = changes.starts_at !== undefined ? instantOf(changes.starts_at) : at
  const end = changes.ends_at !== undefined ? instantOf(changes.ends_at) : at + duration
  checkEvent(start, end, fields)
  const row = overrideRow(b, master, fields, at, start, end)
  b.insert(row)
  const known = b.guestsOf(master.id)
  b.addGuests(row.id, changes.attendee_ids ? guestList(changes.attendee_ids, master.createdBy, known) : known)
  b.plan.resultId = row.id
}

type Retime = { moved: boolean; start: number; end: number; duration: number }

/**
 * The edited occurrence's new times, and the series' new duration. Times left out of the change
 * keep the occurrence's current ones, so a resend of unchanged times moves nothing.
 */
function retime(b: Builder, fields: Fields, changes: EventChanges, at: number): Retime {
  const master = b.state.master!
  const duration = toMs(master.endsAt) - toMs(master.startsAt)
  const override = b.overrideAt(at)
  const current =
    override && !override.cancelled ? { start: toMs(override.startsAt), end: toMs(override.endsAt) } : { start: at, end: at + duration }
  const start = changes.starts_at !== undefined ? instantOf(changes.starts_at) : current.start
  const end = changes.ends_at !== undefined ? instantOf(changes.ends_at) : current.end
  const moved = !sameSecond(start, current.start) || seriesTimeZone(master) !== seriesTimeZone(fields)
  const resized = end - start !== current.end - current.start
  return { moved, start, end, duration: resized ? end - start : duration }
}

type Carry = {
  rule: string | null
  series: SeriesTiming
  fields: Fields
  /** Wall-clock shift from the old series to the new one. */
  shift: number
  duration: number
  guests: Guest[] | null
  edited: { at: number; changes: EventChanges; start: number; end: number } | null
  seriesId?: string
}

/** An occurrence in Trash on its own. It follows the series, so a restore puts it where the series is now */
const trashedOccurrence = (row: EventRow) => row.cancelled && row.deletedAt !== null && row.trashGuests !== null

/**
 * Keeps overrides in step with a changed series. An override whose original start the new series
 * still has stays put, otherwise it is re-based by the series' shift, and dropped when neither fits.
 * Field changes and guest changes reach overrides that had not changed that field themselves.
 */
function carryOverrides(b: Builder, overrides: EventRow[], carry: Carry) {
  const master = b.state.master!
  const z0 = seriesTimeZone(master)
  const z1 = seriesTimeZone(carry.series)
  const oldDuration = toMs(master.endsAt) - toMs(master.startsAt)
  const oldGuests = new Set(b.guestsOf(master.id).map((guest) => guest.userId))
  const newGuests = carry.guests ? new Set(carry.guests.map((guest) => guest.userId)) : null

  const rule = carry.rule
  if (!rule || carry.fields.allDay !== master.allDay) {
    for (const row of overrides) if (!trashedOccurrence(row)) b.remove(row.id)
    return
  }
  const slot = (ms: number) => Math.floor(ms / 1000)
  const stays = new Set(overrides.filter((row) => occursAt(rule, msToStored(toMs(row.originalStart)), carry.series)).map((row) => row.id))
  const taken = new Set(overrides.filter((row) => stays.has(row.id)).map((row) => slot(toMs(row.originalStart))))

  for (const row of overrides) {
    const original = toMs(row.originalStart)
    let rebased: number | null = original
    if (!stays.has(row.id)) {
      const shifted = fromWallClock(wallClock(original, z0) + carry.shift, z1)
      const free = !taken.has(slot(shifted)) && occursAt(rule, msToStored(shifted), carry.series)
      rebased = free ? shifted : null
      if (free) taken.add(slot(shifted))
    }
    if (rebased === null) {
      // A trashed occurrence the series no longer has stays in Trash, and its restore is refused
      if (!trashedOccurrence(row)) b.remove(row.id)
      else if (carry.seriesId) b.update(row.id, { seriesId: carry.seriesId })
      continue
    }

    const set: Partial<EventInsert> = {}
    if (carry.seriesId) set.seriesId = carry.seriesId
    if (rebased !== original) set.originalStart = msToStored(rebased)
    if (!row.cancelled || trashedOccurrence(row)) {
      const start = toMs(row.startsAt)
      const length = toMs(row.endsAt) - start
      const edited = !row.cancelled && carry.edited && sameSecond(original, carry.edited.at) ? carry.edited : null
      if (edited) {
        const own = merge(row, { ...edited.changes, recurrence_rule: undefined, recurrence_tz: undefined, all_day: undefined })
        Object.assign(set, changed(fieldsOf(row), own, SHARED), times(row, edited.start, edited.end))
        if (edited.changes.attendee_ids) {
          b.setGuests(row.id, guestList(edited.changes.attendee_ids, row.createdBy, b.guestsOf(row.id)))
        }
      } else {
        const newStart = sameSecond(start, original) ? rebased : start
        const newLength = length === oldDuration ? carry.duration : length
        Object.assign(set, times(row, newStart, newStart + newLength))
        for (const key of SHARED) {
          if (carry.fields[key] !== master[key] && row[key] === master[key]) Object.assign(set, { [key]: carry.fields[key] })
        }
        if (newGuests && row.cancelled) set.trashGuests = carriedTrashGuests(row.trashGuests ?? [], oldGuests, newGuests)
        else if (newGuests) carryGuests(b, row.id, oldGuests, newGuests)
      }
    }
    b.update(row.id, set)
  }
}

function carryGuests(b: Builder, eventId: string, before: Set<string>, after: Set<string>) {
  const have = new Set(b.guestsOf(eventId).map((guest) => guest.userId))
  for (const userId of after) {
    if (!before.has(userId) && !have.has(userId)) b.plan.guestAdds.push({ eventId, userId, response: "pending" })
  }
  for (const userId of before) {
    if (!after.has(userId) && have.has(userId)) b.plan.guestRemoves.push({ eventId, userId })
  }
}

/** A trashed occurrence's kept guests after the series' guest list changes, as `carryGuests` changes a live row's */
function carriedTrashGuests(kept: Guest[], before: Set<string>, after: Set<string>): Guest[] {
  const have = new Set(kept.map((guest) => guest.userId))
  const added = [...after].filter((userId) => !before.has(userId) && !have.has(userId))
  return [
    ...kept.filter((guest) => !before.has(guest.userId) || after.has(guest.userId)),
    ...added.map((userId) => ({ userId, response: "pending" })),
  ]
}

/** "All events". With an occurrence, the change is made on that occurrence and the series follows it. */
function editAll(b: Builder, changes: EventChanges, at: number | null) {
  const master = b.state.master!
  const fields = merge(master, changes)
  const z0 = seriesTimeZone(master)
  const z1 = seriesTimeZone(fields)
  const masterStart = toMs(master.startsAt)
  let start = masterStart
  let duration = toMs(master.endsAt) - masterStart
  let edited: Carry["edited"] = null

  if (at === null) {
    start = changes.starts_at !== undefined ? instantOf(changes.starts_at) : masterStart
    const end = changes.ends_at !== undefined ? instantOf(changes.ends_at) : toMs(master.endsAt)
    duration = end - start
  } else {
    requireOccurrence(master, at)
    const change = retime(b, fields, changes, at)
    if (change.moved) {
      const days = dayOf(wallClock(at, z0)) - dayOf(wallClock(masterStart, z0))
      start = fromWallClock(wallClock(change.start, z1) - days, z1)
    }
    duration = change.duration
    edited = { at, changes, start: change.start, end: change.end }
  }

  const shift = wallClock(start, z1) - wallClock(masterStart, z0)
  if (fields.recurrenceRule && !ruleChanged(master, changes)) {
    fields.recurrenceRule = shiftUntil(fields.recurrenceRule, shift, z0, z1)
  }
  checkEvent(start, start + duration, fields)
  b.update(master.id, { ...changed(fieldsOf(master), fields), ...times(master, start, start + duration) })
  const guests = changes.attendee_ids ? guestList(changes.attendee_ids, master.createdBy, b.guestsOf(master.id)) : null
  if (guests) b.setGuests(master.id, guests)
  carryOverrides(b, b.state.overrides, {
    rule: fields.recurrenceRule,
    series: { startsAt: msToStored(start), allDay: fields.allDay, recurrenceTz: fields.recurrenceTz },
    fields,
    shift,
    duration,
    guests,
    edited,
  })
  b.plan.resultId = master.id
}

const ruleChanged = (master: EventRow, changes: EventChanges) =>
  changes.recurrence_rule !== undefined && changes.recurrence_rule !== master.recurrenceRule

const timeOfDay = (wall: number) => Math.floor((wall - dayOf(wall)) / 1000)

/**
 * "This and following events": the series ends before the occurrence and a new series starts there.
 * An occurrence in the spring gap starts at a shifted time, so a new series started there would keep
 * that shifted time. That occurrence is changed on its own instead and the new series starts at the next.
 */
function editFollowing(b: Builder, changes: EventChanges, at: number, keepDuration?: number) {
  const master = b.state.master!
  const rule = master.recurrenceRule!
  const { head, tail } = splitSeries(rule, msToStored(at), master)
  if (head === null) return editAll(b, changes, at)

  const fields = merge(master, changes)
  const z0 = seriesTimeZone(master)
  const z1 = seriesTimeZone(fields)
  const change =
    keepDuration === undefined
      ? retime(b, fields, changes, at)
      : { moved: false, start: at, end: at + keepDuration, duration: keepDuration }

  if (!change.moved && timeOfDay(wallClock(at, z0)) !== timeOfDay(wallClock(toMs(master.startsAt), z0))) {
    const next = nextOccurrence(rule, msToStored(at), master)
    editOccurrence(b, { ...changes, recurrence_rule: undefined, recurrence_tz: undefined }, at)
    if (next) {
      const { starts_at: _start, ends_at: _end, ...rest } = changes
      editFollowing(b, rest, instantOf(next), change.duration)
    }
    return
  }

  const start = change.moved ? change.start : at
  const shift = wallClock(start, z1) - wallClock(at, z0)
  const tailRule = ruleChanged(master, changes) ? changes.recurrence_rule! : shiftUntil(tail, shift, z0, z1)
  const tailFields = { ...fields, recurrenceRule: tailRule }
  checkEvent(start, start + change.duration, tailFields)

  const tailId = b.ctx.newId()
  b.insert({
    ...tailFields,
    id: tailId,
    createdBy: master.createdBy,
    organizationId: master.organizationId,
    startsAt: msToStored(start),
    endsAt: msToStored(start + change.duration),
    seriesId: null,
    originalStart: null,
    cancelled: false,
  })
  b.update(master.id, { recurrenceRule: head })
  const known = b.guestsOf(master.id)
  const guests = changes.attendee_ids ? guestList(changes.attendee_ids, master.createdBy, known) : known
  b.addGuests(tailId, guests)

  const later = b.state.overrides.filter((row) => Math.floor(toMs(row.originalStart) / 1000) >= Math.floor(at / 1000))
  carryOverrides(b, later, {
    rule: tailRule,
    series: { startsAt: msToStored(start), allDay: fields.allDay, recurrenceTz: fields.recurrenceTz },
    fields: tailFields,
    shift,
    duration: change.duration,
    guests: changes.attendee_ids ? guests : null,
    edited: keepDuration === undefined ? { at, changes, start: change.start, end: change.end } : null,
    seriesId: tailId,
  })
  b.plan.resultId = tailId
}

function seriesAt(b: Builder, scope: Scope, at: number, changes: EventChanges) {
  if (scope === "all") return editAll(b, changes, at)
  requireOccurrence(b.state.master!, at)
  if (scope === "this") return editOccurrence(b, changes, at)
  return editFollowing(b, changes, at)
}

/**
 * Times in `changes` belong to the occurrence named by `occurrence` (its original start), or to the
 * series itself when "All events" names none. A plain event ignores the scope.
 */
export function planEdit(
  state: SeriesState,
  changes: EventChanges,
  scope: Scope | undefined,
  occurrence: string | undefined,
  ctx: PlanContext,
): Plan {
  const b = new Builder(state, ctx)
  const { target, master } = state
  if (target.seriesId) {
    if (!master) throw new PlanError(404, "Event not found")
    if (!scope || scope === "this") editRow(b, target, sameRuleDropped(changes, master))
    else seriesAt(b, scope, toMs(target.originalStart), changes)
  } else if (!target.recurrenceRule || !master) {
    editRow(b, target, changes)
  } else if (!scope || scope === "all") {
    editAll(b, changes, occurrence === undefined ? null : instantOf(occurrence))
  } else {
    if (occurrence === undefined) throw new PlanError(400, "Name the occurrence to change")
    seriesAt(b, scope, instantOf(occurrence), changes)
  }
  return b.plan
}

function cancel(b: Builder, row: EventRow) {
  b.update(row.id, { cancelled: true })
  b.setGuests(row.id, [])
}

/** "This event" writes a cancelled override, "This and following" ends the series, "All" removes it. */
export function planDelete(state: SeriesState, scope: Scope | undefined, occurrence: string | undefined, ctx: PlanContext): Plan {
  const b = new Builder(state, ctx)
  const { target, master } = state
  if (target.seriesId && (!scope || scope === "this" || !master)) {
    cancel(b, target)
    return b.plan
  }
  if (!target.seriesId && (!target.recurrenceRule || !master || !scope || scope === "all")) {
    b.remove(target.id)
    return b.plan
  }
  const series = master!
  if (scope === "all") {
    b.remove(series.id)
    return b.plan
  }
  if (!target.seriesId && occurrence === undefined) throw new PlanError(400, "Name the occurrence to delete")
  const at = target.seriesId ? toMs(target.originalStart) : instantOf(occurrence!)
  requireOccurrence(series, at)

  if (scope === "this") {
    const existing = b.overrideAt(at)
    if (existing) cancel(b, existing)
    else {
      const duration = toMs(series.endsAt) - toMs(series.startsAt)
      const fields = { ...fieldsOf(series), recurrenceRule: null, recurrenceTz: null }
      b.insert({ ...overrideRow(b, series, fields, at, at, at + duration), cancelled: true })
    }
    return b.plan
  }

  const { head } = splitSeries(series.recurrenceRule!, msToStored(at), series)
  if (head === null) {
    b.remove(series.id)
    return b.plan
  }
  b.update(series.id, { recurrenceRule: head })
  for (const row of state.overrides) {
    if (Math.floor(toMs(row.originalStart) / 1000) >= Math.floor(at / 1000)) b.remove(row.id)
  }
  return b.plan
}

type TrashContext = PlanContext & { by: string; via: Via | null }

const guestPairs = (guests: Guest[]): Guest[] => guests.map(({ userId, response }) => ({ userId, response }))

const trashStamp = (ctx: TrashContext, entryId: string) => ({
  deletedAt: ctx.now,
  deletedBy: ctx.by,
  deletedVia: ctx.via,
  trashRoot: entryId,
})

/**
 * Moves an event, one occurrence or a series to Trash as one entry, `entryId`. "This event" writes the cancelled
 * occurrence a delete writes and keeps its guests in `trashGuests`. "This and following" splits the series and trashes
 * the tail. "All events" trashes the series with its overrides, except occurrences already in Trash on their own
 */
export function planTrash(
  state: SeriesState,
  scope: Scope | undefined,
  occurrence: string | undefined,
  ctx: TrashContext,
): Plan & { entryId: string } {
  const { target, master } = state
  if (target.cancelled) throw new PlanError(404, "Event not found")
  if (scope === "following" && master && (target.seriesId || (target.recurrenceRule && occurrence !== undefined))) {
    const at = target.seriesId ? toMs(target.originalStart) : instantOf(occurrence!)
    requireOccurrence(master, at)
    if (splitSeries(master.recurrenceRule!, msToStored(at), master).head !== null) return trashFollowing(state, at, ctx)
    scope = "all"
  }
  const plan = planDelete(state, scope, occurrence, ctx)
  const [removed] = plan.deletes
  if (removed) {
    const rows = removed === master?.id ? [master, ...state.overrides] : [target]
    plan.deletes = []
    for (const row of rows) {
      if (!row.deletedAt) plan.updates.push({ id: row.id, set: { ...trashStamp(ctx, removed), updatedAt: ctx.now } })
    }
    return { ...plan, entryId: removed }
  }
  const inserted = plan.inserts[0]
  if (inserted) {
    Object.assign(inserted, trashStamp(ctx, inserted.id), { trashGuests: guestPairs(state.guests.get(master!.id) ?? []) })
    return { ...plan, entryId: inserted.id }
  }
  const { id, set } = plan.updates[0]
  const row = [target, ...state.overrides].find((item) => item.id === id)
  if (!row || row.cancelled) throw new PlanError(404, "Event not found")
  Object.assign(set, trashStamp(ctx, id), { trashGuests: guestPairs(state.guests.get(id) ?? []) })
  return { ...plan, entryId: id }
}

/**
 * The split a "This and following" edit makes, with the tail trashed and the later overrides moved to it. Those already
 * in Trash on their own move with it and stay their own entries. In the spring gap the tail starts at the next
 * occurrence, so the one at `at` is cancelled into the same entry
 */
function trashFollowing(state: SeriesState, at: number, ctx: TrashContext): Plan & { entryId: string } {
  const b = new Builder(state, ctx)
  editFollowing(b, {}, at)
  const { plan } = b
  const tail = plan.inserts.find((row) => !row.seriesId)
  const gapInsert = plan.inserts.find((row) => row.seriesId && sameSecond(toMs(row.originalStart ?? null), at))
  const gapRow = gapInsert ?? (tail && sameSecond(toMs(tail.startsAt), at) ? undefined : b.overrideAt(at))
  const entryId = tail?.id ?? gapRow!.id
  const stamp = trashStamp(ctx, entryId)
  if (tail) Object.assign(tail, stamp)

  const byId = new Map(state.overrides.map((row) => [row.id, row]))
  for (const id of plan.deletes) b.update(id, { seriesId: entryId })
  plan.deletes = []
  for (const { id, set } of plan.updates) {
    if (tail && set.seriesId === tail.id && !byId.get(id)?.deletedAt) Object.assign(set, stamp)
  }

  if (gapInsert) {
    const guests = plan.guestAdds.filter((guest) => guest.eventId === gapInsert.id)
    plan.guestAdds = plan.guestAdds.filter((guest) => guest.eventId !== gapInsert.id)
    Object.assign(gapInsert, stamp, { cancelled: true, trashGuests: guestPairs(guests) })
  } else if (gapRow) {
    b.update(gapRow.id, { ...stamp, cancelled: true, trashGuests: guestPairs(b.guestsOf(gapRow.id)) })
    b.setGuests(gapRow.id, [])
  }
  return { ...plan, entryId }
}

/** Whether the series still has the occurrence an override stands for, after its rule or all-day changed */
export function stillInSeries(series: EventRow, row: EventRow): boolean {
  const original = storedMs(row.originalStart)
  return (
    !!series.recurrenceRule &&
    series.allDay === row.allDay &&
    original !== null &&
    occursAt(series.recurrenceRule, msToStored(original), series)
  )
}

/**
 * Brings back every row of the Trash entry. A row the trash cancelled, an occurrence, shows again with the guests it
 * had. An occurrence whose series is in Trash comes back only with the series
 */
export function planRestore(state: SeriesState, entryId: string, ctx: PlanContext): Plan {
  const b = new Builder(state, ctx)
  const rows = new Map(
    [state.target, ...(state.master ? [state.master] : []), ...state.overrides, ...(state.strays ?? [])].map((row) => [row.id, row]),
  )
  const entry = rows.get(entryId)
  if (!entry?.deletedAt || entry.trashRoot !== entryId) throw new PlanError(404, "Event not found")
  const series = entry.seriesId && state.master?.id === entry.seriesId ? state.master : null
  if (series?.deletedAt) throw new PlanError(409, "Restore the series first")
  if (series && !stillInSeries(series, entry)) throw new PlanError(409, "This occurrence is no longer part of the series")
  for (const row of rows.values()) {
    if (row.trashRoot !== entryId || !row.deletedAt) continue
    const back: Partial<EventInsert> = { deletedAt: null, deletedBy: null, deletedVia: null, trashRoot: null, trashGuests: null }
    if (row.trashGuests) {
      const have = new Set(b.guestsOf(row.id).map((guest) => guest.userId))
      b.addGuests(
        row.id,
        row.trashGuests.filter((guest) => !have.has(guest.userId)),
      )
      b.update(row.id, { cancelled: false, ...back })
    } else b.update(row.id, back)
  }
  b.plan.resultId = entryId
  return b.plan
}

/** The start of the series' next occurrence after `now` that isn't cancelled, where its override puts it */
function nextShown(series: EventRow, overrides: EventRow[], now: number): number | null {
  let after = msToStored(now)
  for (let step = 0; step < 50; step++) {
    const next = nextOccurrence(series.recurrenceRule!, after, series)
    if (!next) return null
    const at = storedMs(next)!
    const override = overrides.find((row) => row.seriesId === series.id && sameSecond(toMs(row.originalStart), at))
    if (!override) return at
    if (!override.cancelled) return toMs(override.startsAt)
    after = msToStored(at)
  }
  return null
}

/**
 * The day to name and the guests to tell when an entry goes to Trash or comes back: the rows it holds after a trash,
 * or before a restore, each with the guests it had
 */
export function entryNotice(
  state: SeriesState,
  plan: Plan,
  entryId: string,
  occurrence?: string,
  now = Date.now(),
): { startsAt: string; allDay: boolean; guests: Guest[]; everyone: boolean } | null {
  const before = [state.target, ...(state.master ? [state.master] : []), ...state.overrides, ...(state.strays ?? [])]
  const after = new Map<string, EventInsert & { id: string }>(before.map((row) => [row.id, { ...row }]))
  for (const row of plan.inserts) after.set(row.id, row)
  for (const { id, set } of plan.updates) if (after.has(id)) Object.assign(after.get(id)!, set)
  const restoring = plan.updates.some((update) => update.id === entryId && update.set.deletedAt === null)
  const rows: (EventInsert & { id: string })[] = restoring ? before : [...after.values()]
  const told = new Map<string, Guest>()
  for (const row of rows) {
    if (row.trashRoot !== entryId) continue
    const added = plan.guestAdds.filter((guest) => guest.eventId === row.id)
    for (const { userId, response } of row.trashGuests ?? state.guests.get(row.id) ?? added) {
      if (!told.has(userId) || told.get(userId)!.response === "no") told.set(userId, { userId, response })
    }
  }
  const entry = after.get(entryId)
  if (!entry) return null
  const at = entry.seriesId
    ? storedMs(entry.startsAt)
    : occurrence !== undefined
      ? parseInstant(occurrence)
      : restoring && entry.recurrenceRule
        ? (nextShown(entry as EventRow, state.overrides, now) ?? storedMs(entry.startsAt))
        : storedMs(state.target.startsAt)
  if (at === null) return null
  return {
    startsAt: new Date(at).toISOString(),
    allDay: entry.allDay ?? false,
    guests: [...told.values()],
    everyone: (state.master ?? state.target).everyone,
  }
}

export type RoomPurge = {
  room: string
  /** The series whose live guests decide who stays. */
  seriesId: string
  /** Null means everyone but the creator, or every non-guest when `keepGuests` is set. */
  userIds: string[] | null
  keepGuests: boolean
}

type RoomRow = Pick<EventRow, "id" | "seriesId" | "videoCall" | "everyone" | "cancelled"> & { deletedAt?: string | null }

/**
 * One room per series, `meeting-{masterId}`. It opens when any live row of the series, the master or
 * an override that is not cancelled, has a video call, and any member may enter when one is an
 * Everyone event.
 */
export function seriesRoom(rows: RoomRow[], masterId: string): { video: boolean; everyone: boolean } {
  const live = rows.filter((row) => !row.cancelled && !row.deletedAt && (row.seriesId ?? row.id) === masterId)
  return { video: live.some((row) => row.videoCall), everyone: live.some((row) => row.everyone) }
}

/**
 * Participant rows to clear after a plan, so nobody gets back in through an old in-call invite. The
 * series room is cleared when its last live video call goes, its non-guests when its last Everyone row
 * goes, and a removed guest unless they are still a live guest of the series. The creator's row is
 * never removed. A deleted series loses its room's rows with the delete.
 */
export function roomPurge(state: SeriesState, plan: Plan): { creatorId: string; entries: RoomPurge[] } {
  const rows = new Map([state.target, ...(state.master ? [state.master] : []), ...state.overrides].map((row) => [row.id, row]))
  const creatorId = (state.master ?? state.target).createdBy
  const seriesId = state.master?.id ?? state.target.seriesId ?? state.target.id
  if (plan.deletes.includes(seriesId)) return { creatorId, entries: [] }
  const set = (id: string) => plan.updates.find((update) => update.id === id)?.set ?? {}
  const after: RoomRow[] = [
    ...[...rows.values()].filter((row) => !plan.deletes.includes(row.id)).map((row) => ({ ...row, ...set(row.id) }) as RoomRow),
    ...plan.inserts.map((row) => ({
      id: row.id,
      seriesId: row.seriesId ?? null,
      videoCall: row.videoCall ?? false,
      everyone: row.everyone ?? false,
      cancelled: row.cancelled ?? false,
      deletedAt: row.deletedAt ?? null,
    })),
  ]
  const was = seriesRoom([...rows.values()], seriesId)
  const now = seriesRoom(after, seriesId)
  const removed = [...new Set(plan.guestRemoves.map((guest) => guest.userId))].filter((id) => id !== creatorId)

  const room = `meeting-${seriesId}`
  const entries: RoomPurge[] = []
  if (was.video && !now.video) entries.push({ room, seriesId, userIds: null, keepGuests: false })
  else if (was.everyone && !now.everyone) entries.push({ room, seriesId, userIds: null, keepGuests: true })
  else if (removed.length) entries.push({ room, seriesId, userIds: removed, keepGuests: true })
  return { creatorId, entries }
}

/** Everyone who should hear about a change: the creator and every guest, before and after it. */
export function audienceOf(state: SeriesState, plan?: Plan): { userIds: Set<string>; everyone: boolean } {
  const rows = [state.target, ...(state.master ? [state.master] : []), ...state.overrides]
  const userIds = new Set<string>()
  let everyone = false
  for (const row of rows) {
    userIds.add(row.createdBy)
    everyone ||= row.everyone
    for (const guest of state.guests.get(row.id) ?? []) userIds.add(guest.userId)
  }
  for (const guest of plan?.guestAdds ?? []) userIds.add(guest.userId)
  for (const row of plan?.inserts ?? []) everyone ||= row.everyone === true
  for (const update of plan?.updates ?? []) everyone ||= update.set.everyone === true
  return { userIds, everyone }
}
