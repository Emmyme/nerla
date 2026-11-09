import { and, asc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { randomUUID } from "node:crypto"
import {
  db,
  calendarEvents,
  calendarShareGrants,
  calendarSharing,
  eventAttendees,
  meetingParticipants,
  users,
  type Executor,
  type Tx,
} from "../db"
import { toVisibleEventDto, type AttendeeInput, type EventDto, type PersonInput } from "../utils/eventDto"
import { DAY_MS, inWindow, msToStored, parseInstant, readInstant, storedMs, writeInstant } from "../utils/eventTime"
import {
  askerDay,
  busyOf,
  findSlots,
  freeWindow,
  hasHours,
  LATEST_AFTER_EARLIEST,
  zoneOr,
  type FreePerson,
  type Interval,
} from "../utils/freeSlots"
import {
  DEFAULT_SHARE_LEVEL,
  teamFloor,
  visibilityFor,
  type BusyDto,
  type GrantLevel,
  type Visibility,
  type ShareLevel,
  type SharingTowardViewer,
} from "../utils/eventVisibility"
import { availabilityChangesAt, availabilityOf, type Availability, type AvailabilityEvent, type WorkingHours } from "../utils/availability"
import { expandSeries } from "../utils/recurrence"
import { audienceOf, roomPurge, seriesRoom, stillInSeries, type Plan, type RoomPurge, type SeriesState } from "../utils/seriesEdit"
import { DEFAULT_REMINDER_MINUTES, type calendarEventCreateBodySchema, type calendarFreeQuerySchema } from "../validation/schemas"
import { emitCalendarChanged } from "./websocket"
import { calendarPresenceChanged } from "./presence"
import { memberIdsOf, orgMemberIds, outsiders } from "./tenancy"
import { liveEvent } from "../utils/trash"
import type { z } from "zod"
import type { Via } from "../utils/aiTypes"

type EventRow = typeof calendarEvents.$inferSelect
type Guest = AttendeeInput & { eventId: string }

export type Viewer = { id: string; organizationId: string }
type Range = { from: number; to: number }
export type VisibleEvent = EventDto | BusyDto

/** Sharing is not consulted in My calendar, where only the always-full rules apply. */
const NOT_SHARED: SharingTowardViewer = { default_level: "private", grantToViewer: null }

const attendeeOf = (userIds: string[]) =>
  inArray(calendarEvents.id, db.select({ id: eventAttendees.eventId }).from(eventAttendees).where(inArray(eventAttendees.userId, userIds)))

/**
 * Skips a series whose UNTIL date is more than its own length and a day before `from`. The day covers
 * a floating or date-only UNTIL in any zone. Series without UNTIL, COUNT ones included, are kept.
 */
export const notEndedBefore = (from: string) =>
  sql`(${calendarEvents.recurrenceRule} not like '%UNTIL=%' or substring(${calendarEvents.recurrenceRule} from 'UNTIL=([0-9]{8})') >= to_char(${from}::timestamp - (${calendarEvents.endsAt} - ${calendarEvents.startsAt}) - interval '1 day', 'YYYYMMDD'))`

/**
 * Every occurrence in the range of the events matched by `related`, in three queries whatever the
 * number of events: the matching rows, then the masters they need and the overrides of those masters.
 * The query window is a day wider on each side, so all-day dates are never cut by a time zone, and the
 * result is clipped to the range afterwards.
 */
async function occurrencesIn(organizationId: string, related: SQL, range: Range, executor: Executor = db): Promise<EventRow[]> {
  const from = msToStored(range.from - DAY_MS)
  const to = msToStored(range.to + DAY_MS)
  const rows = await executor
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.organizationId, organizationId),
        eq(calendarEvents.cancelled, false),
        liveEvent,
        related,
        or(
          and(isNull(calendarEvents.recurrenceRule), lt(calendarEvents.startsAt, to), gte(calendarEvents.endsAt, from)),
          and(
            isNotNull(calendarEvents.recurrenceRule),
            isNull(calendarEvents.seriesId),
            lt(calendarEvents.startsAt, to),
            notEndedBefore(from),
          ),
        ),
      ),
    )

  const loaded = new Map(rows.map((row) => [row.id, row]))
  const masterIds = new Set(rows.flatMap((row) => (row.seriesId ? [row.seriesId] : row.recurrenceRule ? [row.id] : [])))
  const missing = [...masterIds].filter((id) => !loaded.has(id))
  // trash: joined only to give an override its master's length, and masters come from the live rows above
  const master = alias(calendarEvents, "master")
  const [extra, overrides] = await Promise.all([
    missing.length
      ? executor
          .select()
          .from(calendarEvents)
          .where(and(eq(calendarEvents.organizationId, organizationId), inArray(calendarEvents.id, missing), liveEvent))
      : Promise.resolve([] as EventRow[]),
    masterIds.size
      ? executor
          .select(getTableColumns(calendarEvents))
          .from(calendarEvents)
          .innerJoin(master, eq(calendarEvents.seriesId, master.id))
          .where(
            and(
              inArray(calendarEvents.seriesId, [...masterIds]),
              // trash: a cancelled occurrence in Trash still keeps its series from showing that day
              or(eq(calendarEvents.cancelled, true), liveEvent),
              or(
                and(lt(calendarEvents.startsAt, to), gte(calendarEvents.endsAt, from)),
                and(
                  lt(calendarEvents.originalStart, to),
                  sql`${calendarEvents.originalStart} + (${master.endsAt} - ${master.startsAt}) >= ${from}::timestamp`,
                ),
              ),
            ),
          )
      : Promise.resolve([] as EventRow[]),
  ])

  const overridesBy = new Map<string, EventRow[]>()
  for (const row of overrides) overridesBy.set(row.seriesId!, [...(overridesBy.get(row.seriesId!) ?? []), row])

  const keep = (row: EventRow) => inWindow(storedMs(row.startsAt)!, storedMs(row.endsAt)!, row.allDay, range)
  const window = { from: new Date(range.from - DAY_MS).toISOString(), to: new Date(range.to + DAY_MS).toISOString() }
  const out: EventRow[] = []
  for (const row of [...rows, ...extra]) {
    if (row.seriesId) continue
    if (row.recurrenceRule && masterIds.has(row.id)) {
      out.push(...expandSeries(row, overridesBy.get(row.id) ?? [], window).filter(keep))
    } else if (!row.recurrenceRule && loaded.has(row.id)) {
      if (keep(row)) out.push(row)
    }
  }
  return out
}

/** The user's own out of office occurrences, read with the caller's executor so a transaction keeps to its connection */
export function ownOutOfOffice(executor: Executor, viewer: Viewer, range: Range): Promise<EventRow[]> {
  const related = and(eq(calendarEvents.createdBy, viewer.id), eq(calendarEvents.eventType, "ooo"))!
  return occurrencesIn(viewer.organizationId, related, range, executor)
}

async function guestsOf(eventIds: string[], executor: Executor = db): Promise<Map<string, Guest[]>> {
  const ids = [...new Set(eventIds)]
  const byEvent = new Map<string, Guest[]>()
  if (ids.length === 0) return byEvent
  const rows = await executor
    .select({
      eventId: eventAttendees.eventId,
      userId: eventAttendees.userId,
      response: eventAttendees.response,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarUrl: users.avatarUrl,
    })
    .from(eventAttendees)
    .innerJoin(users, eq(users.id, eventAttendees.userId))
    .where(inArray(eventAttendees.eventId, ids))
    .orderBy(asc(eventAttendees.createdAt))
  for (const row of rows) byEvent.set(row.eventId, [...(byEvent.get(row.eventId) ?? []), row])
  return byEvent
}

/** The organizers of the rows, by id, in one query. */
async function organizersOf(rows: { createdBy: string }[]): Promise<Map<string, PersonInput>> {
  const ids = [...new Set(rows.map((row) => row.createdBy))]
  if (ids.length === 0) return new Map()
  const people = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(inArray(users.id, ids))
  return new Map(people.map((person) => [person.id, person]))
}

const GRANT_RANK: Record<string, number> = { busy: 1, everything: 2 }

/** Each owner's sharing toward the viewer: their workspace default and their grant to the viewer in this workspace. */
export async function sharingToward(viewer: Viewer, ownerIds: string[]): Promise<(ownerId: string) => SharingTowardViewer> {
  const owners = [...new Set(ownerIds)]
  if (owners.length === 0) return () => ({ default_level: DEFAULT_SHARE_LEVEL, grantToViewer: null })
  const [levels, grants] = await Promise.all([
    db.select().from(calendarSharing).where(inArray(calendarSharing.userId, owners)),
    db
      .select()
      .from(calendarShareGrants)
      .where(
        and(
          eq(calendarShareGrants.granteeId, viewer.id),
          inArray(calendarShareGrants.ownerId, owners),
          eq(calendarShareGrants.organizationId, viewer.organizationId),
        ),
      ),
  ])
  const levelBy = new Map(levels.map((row) => [row.userId, row.defaultLevel as ShareLevel]))
  const grantBy = new Map<string, GrantLevel>()
  for (const grant of grants) {
    const current = grantBy.get(grant.ownerId)
    if (!current || (GRANT_RANK[grant.level] ?? 0) > GRANT_RANK[current]) grantBy.set(grant.ownerId, grant.level as GrantLevel)
  }
  return (ownerId) => ({
    default_level: levelBy.get(ownerId) ?? DEFAULT_SHARE_LEVEL,
    grantToViewer: grantBy.get(ownerId) ?? null,
  })
}

/** Private, or an unknown level, without a grant keeps a user out of Team view. */
function listed(sharing: SharingTowardViewer): boolean {
  return sharing.grantToViewer !== null || sharing.default_level === "details" || sharing.default_level === "busy"
}

const byStart = (a: VisibleEvent, b: VisibleEvent) => (a.starts_at ?? "").localeCompare(b.starts_at ?? "") || a.id.localeCompare(b.id)

/** My calendar: own events, invitations and Everyone events, never redacted. */
export async function listMine(viewer: Viewer, range: Range): Promise<VisibleEvent[]> {
  const related = or(eq(calendarEvents.createdBy, viewer.id), eq(calendarEvents.everyone, true), attendeeOf([viewer.id]))!
  const occurrences = await occurrencesIn(viewer.organizationId, related, range)
  const [guests, organizers] = await Promise.all([guestsOf(occurrences.map((row) => row.id)), organizersOf(occurrences)])
  const out: VisibleEvent[] = []
  for (const row of occurrences) {
    const list = guests.get(row.id) ?? []
    const own = list.find((guest) => guest.userId === viewer.id)
    const visibility = visibilityFor(row, viewer, {
      isCreator: row.createdBy === viewer.id,
      isAttendee: !!own,
      ownerSharing: NOT_SHARED,
      creatorSharing: NOT_SHARED,
      mode: "mine",
    })
    const dto = toVisibleEventDto(row, visibility, {
      calendarUserId: viewer.id,
      attendees: list,
      viewerResponse: own?.response ?? null,
      organizer: organizers.get(row.createdBy),
    })
    if (dto) out.push(dto)
  }
  return out.sort(byStart)
}

/**
 * Team view: each user's own events and invitations, as the viewer may see them. An event on X's
 * calendar shows no more than both X's and its creator's sharing allow.
 */
export async function listTeam(viewer: Viewer, userIds: string[], range: Range): Promise<Record<string, VisibleEvent[]>> {
  const people = [...new Set(userIds)]
  const strangers = new Set(await outsiders(viewer.organizationId, people))
  const members = people.filter((id) => !strangers.has(id))
  if (members.length === 0) return {}

  const related = or(inArray(calendarEvents.createdBy, members), attendeeOf(members))!
  const occurrences = await occurrencesIn(viewer.organizationId, related, range)
  const [guests, sharing, organizers] = await Promise.all([
    guestsOf(occurrences.map((row) => row.id)),
    sharingToward(viewer, [...members, ...occurrences.map((row) => row.createdBy)]),
    organizersOf(occurrences),
  ])

  const calendars: Record<string, VisibleEvent[]> = {}
  for (const id of members) if (id === viewer.id || listed(sharing(id))) calendars[id] = []

  for (const row of occurrences) {
    const list = guests.get(row.id) ?? []
    const own = list.find((guest) => guest.userId === viewer.id)
    const declined = new Set(list.filter((guest) => guest.response === "no").map((guest) => guest.userId))
    for (const person of new Set([row.createdBy, ...list.map((guest) => guest.userId)])) {
      if (!calendars[person] || (person !== row.createdBy && declined.has(person))) continue
      const seen = visibilityFor(row, viewer, {
        isCreator: row.createdBy === viewer.id,
        isAttendee: !!own,
        ownerSharing: sharing(person),
        creatorSharing: sharing(row.createdBy),
        mode: "team",
      })
      // Out of office always shows, but only on the calendar of the user who is away
      const visibility = person === row.createdBy ? teamFloor(row.eventType, seen) : seen
      const dto = toVisibleEventDto(row, visibility, {
        calendarUserId: person,
        attendees: list,
        viewerResponse: own?.response ?? null,
        organizer: organizers.get(row.createdBy),
      })
      if (dto) calendars[person].push(dto)
    }
  }
  for (const list of Object.values(calendars)) list.sort(byStart)
  return calendars
}

type FreeBusy = { busy: Interval[] | null; ooo: Interval[] }

const busyEvent = (row: EventRow) => ({
  starts_at: readInstant(row.startsAt),
  ends_at: readInstant(row.endsAt),
  all_day: row.allDay,
  event_type: row.eventType,
})

/**
 * Free and busy as the viewer may know it: their own calendar without the invites they declined, and for each
 * teammate who shares their calendar with the viewer, every event they made or haven't declined. That one counts
 * as busy even when its creator keeps it private, since only its time is used. A calendar not shared has
 * `busy: null` and only its owner's out of office, which always shows. Each user's zone reads their all-day dates.
 */
async function busyFor(viewer: Viewer, people: { id: string; timeZone: string }[], range: Range): Promise<Map<string, FreeBusy>> {
  const others = people.filter((person) => person.id !== viewer.id).map((person) => person.id)
  const [mine, occurrences] = await Promise.all([
    people.some((person) => person.id === viewer.id) ? listMine(viewer, range) : Promise.resolve([]),
    others.length
      ? occurrencesIn(viewer.organizationId, or(inArray(calendarEvents.createdBy, others), attendeeOf(others))!, range)
      : Promise.resolve([] as EventRow[]),
  ])
  const [guests, sharing] = await Promise.all([guestsOf(occurrences.map((row) => row.id)), sharingToward(viewer, others)])
  const result = new Map<string, FreeBusy>()
  for (const person of people) {
    if (person.id === viewer.id) {
      const kept = mine.filter((event) => !("viewer_response" in event && event.viewer_response === "no"))
      result.set(person.id, { busy: busyOf(kept, person.timeZone), ooo: [] })
      continue
    }
    const own = (row: EventRow) => row.createdBy === person.id
    if (listed(sharing(person.id))) {
      const rows = occurrences.filter(
        (row) => own(row) || (guests.get(row.id) ?? []).some((guest) => guest.userId === person.id && guest.response !== "no"),
      )
      result.set(person.id, { busy: busyOf(rows.map(busyEvent), person.timeZone), ooo: [] })
    } else {
      const away = occurrences.filter((row) => own(row) && row.eventType === "ooo")
      result.set(person.id, { busy: null, ooo: busyOf(away.map(busyEvent), person.timeZone) })
    }
  }
  return result
}

type FreeQuery = z.infer<typeof calendarFreeQuerySchema>
export type FreeAnswer = {
  slots: { starts_at: string; ends_at: string }[]
  people: { id: string; calendar: "shared" | "not_shared"; working_hours: boolean }[]
}

/** Times when the viewer and everyone named are free, with whether each calendar is shared and has working hours */
export async function freeTimes(viewer: Viewer, query: FreeQuery, now = Date.now()): Promise<FreeAnswer | { error: string }> {
  const ids = [viewer.id, ...query.users.filter((id) => id !== viewer.id)]
  const rows = await db
    .select({ id: users.id, timeZone: users.timeZone, workingHours: users.workingHours, workBreaks: users.workBreaks })
    .from(users)
    .where(inArray(users.id, ids))
  const profile = new Map(rows.map((row) => [row.id, row]))
  const askerZone = zoneOr(query.time_zone ?? profile.get(viewer.id)?.timeZone, "UTC")
  const day = askerDay(profile.get(viewer.id)?.workingHours ?? null, query.day_start, query.day_end)
  if (!day) return { error: LATEST_AFTER_EARLIEST }
  const window = freeWindow(
    { from: query.start ? parseInstant(query.start)! : undefined, to: query.end ? parseInstant(query.end)! : undefined },
    now,
    askerZone,
    day,
  )
  if ("error" in window) return window
  const zoneOf = (id: string) => zoneOr(profile.get(id)?.timeZone, askerZone)
  const range = { from: window.start, to: window.end }
  const known = await busyFor(
    viewer,
    ids.map((id) => ({ id, timeZone: zoneOf(id) })),
    range,
  )
  const people: FreePerson[] = ids.map((id) => ({
    id,
    busy: known.get(id)?.busy ?? null,
    ooo: known.get(id)?.ooo ?? [],
    hours: profile.get(id)?.workingHours ?? null,
    breaks: profile.get(id)?.workBreaks ?? null,
    timeZone: zoneOf(id),
  }))
  const slots = findSlots({ people, askerZone, day, from: range.from, to: range.to, minutes: query.minutes, now })
  return {
    slots: slots.map((slot) => ({ starts_at: new Date(slot.start).toISOString(), ends_at: new Date(slot.end).toISOString() })),
    people: people.map((person) => ({
      id: person.id,
      calendar: person.busy ? "shared" : "not_shared",
      working_hours: hasHours(person.hours),
    })),
  }
}

type AvailabilityPerson = { id: string; timeZone: string | null; workingHours: WorkingHours | null }
type AvailabilityNow = { availability: Availability; changesAt?: number }

/**
 * What each user is up to now as the viewer may know it, and when that may next change, in one pass.
 * Out of office always counts. Other events count only when the user shares their calendar with the
 * viewer, and only as the sharing rules show them.
 */
export async function availabilitiesFor(
  viewer: Viewer,
  people: AvailabilityPerson[],
  nowMs = Date.now(),
): Promise<Map<string, AvailabilityNow>> {
  const result = new Map<string, AvailabilityNow>()
  if (people.length === 0) return result
  const ids = people.map((person) => person.id)
  const related = or(inArray(calendarEvents.createdBy, ids), attendeeOf(ids))!
  const occurrences = await occurrencesIn(viewer.organizationId, related, { from: nowMs, to: nowMs + DAY_MS })
  const [guests, sharing] = await Promise.all([
    guestsOf(occurrences.map((row) => row.id)),
    sharingToward(viewer, [...ids, ...occurrences.map((row) => row.createdBy)]),
  ])
  for (const person of people) {
    const shares = person.id === viewer.id || listed(sharing(person.id))
    const events: AvailabilityEvent[] = []
    for (const row of occurrences) {
      const list = guests.get(row.id) ?? []
      const own = row.createdBy === person.id
      if (!own && !list.some((guest) => guest.userId === person.id && guest.response !== "no")) continue
      if (row.eventType === "ooo" ? !own : !shares) continue
      const visibility = teamFloor(
        row.eventType,
        visibilityFor(row, viewer, {
          isCreator: row.createdBy === viewer.id,
          isAttendee: list.some((guest) => guest.userId === viewer.id),
          ownerSharing: sharing(person.id),
          creatorSharing: sharing(row.createdBy),
          mode: "team",
        }),
      )
      events.push({
        startMs: storedMs(row.startsAt)!,
        endMs: storedMs(row.endsAt)!,
        allDay: row.allDay,
        eventType: row.eventType,
        title: row.title,
        visibility,
      })
    }
    const input = { nowMs, events, workingHours: person.workingHours, timeZone: person.timeZone }
    result.set(person.id, { availability: availabilityOf(input), changesAt: availabilityChangesAt(input) })
  }
  return result
}

export async function availabilityFor(viewer: Viewer, person: AvailabilityPerson, nowMs = Date.now()): Promise<Availability> {
  return (await availabilitiesFor(viewer, [person], nowMs)).get(person.id)!.availability
}

/**
 * One row as the viewer may see it, or null. `calendarUserId` names the calendar it was opened on,
 * which decides whose sharing applies. Without it, the creator's own calendar is assumed.
 */
export async function loadVisible(viewer: Viewer, id: string, calendarUserId?: string): Promise<VisibleEvent | null> {
  const row = await db.query.calendarEvents.findFirst({
    where: and(eq(calendarEvents.id, id), eq(calendarEvents.organizationId, viewer.organizationId), liveEvent),
  })
  if (!row || row.cancelled) return null
  return (await resolve(viewer, row, calendarUserId)).dto
}

/** How the viewer sees a row on its creator's own calendar. A cancelled row is hidden. */
export async function visibilityOf(viewer: Viewer, row: EventRow): Promise<Visibility> {
  return row.cancelled ? "hidden" : (await resolve(viewer, row)).visibility
}

async function resolve(viewer: Viewer, row: EventRow, calendarUserId?: string) {
  const [guests, organizers] = await Promise.all([guestsOf([row.id]), organizersOf([row])])
  const list = guests.get(row.id) ?? []
  const own = list.find((guest) => guest.userId === viewer.id)
  const onCalendar =
    calendarUserId && (calendarUserId === row.createdBy || list.some((guest) => guest.userId === calendarUserId)) ? calendarUserId : null
  const owner = onCalendar ?? row.createdBy
  const sharing = await sharingToward(viewer, [owner, row.createdBy])
  const isCreator = row.createdBy === viewer.id
  const visibility = visibilityFor(row, viewer, {
    isCreator,
    isAttendee: !!own,
    ownerSharing: sharing(owner),
    creatorSharing: sharing(row.createdBy),
    mode: "team",
  })
  const mine = isCreator || !!own || row.everyone
  const dto = toVisibleEventDto(row, visibility, {
    calendarUserId: onCalendar ?? (mine ? viewer.id : owner),
    attendees: list,
    viewerResponse: own?.response ?? null,
    organizer: organizers.get(row.createdBy),
  })
  return { visibility, dto }
}

type CreateBody = z.infer<typeof calendarEventCreateBodySchema>

export async function createEvent(viewer: Viewer, body: CreateBody, via: Via | null = null): Promise<{ id: string; guests: string[] }> {
  const eventType = body.event_type ?? "meeting"
  const guests = [...new Set(body.attendee_ids ?? [])].filter((id) => id !== viewer.id)
  const id = randomUUID()
  await db.transaction(async (tx) => {
    await tx.insert(calendarEvents).values({
      id,
      title: body.title,
      description: body.description ?? null,
      location: body.location ?? null,
      startsAt: writeInstant(body.starts_at),
      endsAt: writeInstant(body.ends_at),
      allDay: body.all_day ?? false,
      eventType,
      videoCall: body.video_call ?? eventType === "meeting",
      everyone: body.everyone ?? false,
      recurrenceRule: body.recurrence_rule ?? null,
      recurrenceTz: body.recurrence_tz ?? null,
      reminderMinutes: body.reminder_minutes === undefined ? DEFAULT_REMINDER_MINUTES : body.reminder_minutes,
      doneVia: via,
      createdBy: viewer.id,
      organizationId: viewer.organizationId,
    })
    if (guests.length) {
      await tx.insert(eventAttendees).values(guests.map((userId) => ({ eventId: id, userId, organizationId: viewer.organizationId })))
    }
  })
  return { id, guests }
}

/**
 * The row named by `id`, with its series master, every override and every guest list. With `lock`,
 * the master (or the plain row) is locked first, so concurrent edits of one series run one at a time
 * and each plans from the rows the other committed.
 */
export async function loadSeriesState(
  organizationId: string,
  id: string,
  executor: Executor = db,
  lock = false,
): Promise<SeriesState | null> {
  // trash: the plans work on the whole family, rows in Trash included, and callers refuse a target in Trash
  const target = await executor.query.calendarEvents.findFirst({
    where: and(eq(calendarEvents.id, id), eq(calendarEvents.organizationId, organizationId)),
  })
  if (!target) return null
  const masterId = target.seriesId ?? (target.recurrenceRule ? target.id : null)
  if (lock) {
    // trash: a lock only, on the row read above
    await executor
      .select({ id: calendarEvents.id })
      .from(calendarEvents)
      .where(eq(calendarEvents.id, masterId ?? target.id))
      .for("update")
  }
  // trash: the whole family, so a restore and "This and following" see their rows
  const family = await executor
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.organizationId, organizationId),
        masterId ? or(eq(calendarEvents.id, masterId), eq(calendarEvents.seriesId, masterId)) : eq(calendarEvents.id, target.id),
      ),
    )
  const current = family.find((row) => row.id === target.id)
  if (!current) return null
  const strays =
    current.deletedAt && current.trashRoot === current.id
      ? await executor
          .select()
          .from(calendarEvents)
          .where(
            and(
              eq(calendarEvents.organizationId, organizationId),
              eq(calendarEvents.trashRoot, current.id),
              isNotNull(calendarEvents.deletedAt),
              notInArray(
                calendarEvents.id,
                family.map((row) => row.id),
              ),
            ),
          )
      : []
  const guests = await guestsOf(
    [...family, ...strays].map((row) => row.id),
    executor,
  )
  return {
    target: current,
    master: masterId ? (family.find((row) => row.id === masterId) ?? null) : null,
    overrides: masterId ? family.filter((row) => row.seriesId === masterId) : [],
    guests,
    ...(strays.length ? { strays } : {}),
  }
}

/**
 * Plans and runs a change in one transaction, from rows read under the series lock. Returns null
 * when the row is gone, or in Trash unless `inTrash` lets the plan work on it. A planning error rolls everything back.
 */
export async function changeSeries<P extends Plan>(
  organizationId: string,
  id: string,
  build: (state: SeriesState) => P,
  { inTrash = false }: { inTrash?: boolean } = {},
): Promise<{ state: SeriesState; plan: P } | null> {
  return db.transaction(async (tx) => {
    const state = await loadSeriesState(organizationId, id, tx, true)
    if (!state) return null
    if (!inTrash && (state.target.deletedAt || state.master?.deletedAt)) return null
    const plan = build(state)
    await applyPlan(tx, organizationId, plan, state)
    return { state, plan }
  })
}

type EventTrashEntry = Pick<EventRow, "id" | "createdBy" | "deletedBy" | "seriesId" | "deletedAt">

/** A Trash entry of the workspace, the row whose `trash_root` is its own id. Null when there is none */
export async function eventTrashEntry(organizationId: string, id: string, executor: Executor = db): Promise<EventTrashEntry | null> {
  const [entry] = await executor
    .select({
      id: calendarEvents.id,
      createdBy: calendarEvents.createdBy,
      deletedBy: calendarEvents.deletedBy,
      seriesId: calendarEvents.seriesId,
      deletedAt: calendarEvents.deletedAt,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.id, id),
        eq(calendarEvents.organizationId, organizationId),
        eq(calendarEvents.trashRoot, id),
        isNotNull(calendarEvents.deletedAt),
      ),
    )
  return entry ?? null
}

/**
 * Deletes a Trash entry for good, only while it is still in Trash and trashed before the cutoff when given, under the
 * series lock a restore takes. An occurrence only leaves Trash and stays cancelled, since its series still skips it, and
 * goes for good once the series no longer has it. Any other entry loses its rows, its overrides with them, and its room
 */
export async function purgeEvent(
  entryId: string,
  organizationId: string,
  guard: { trashedBefore?: string; allowed?: (entry: EventTrashEntry) => boolean },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const state = await loadSeriesState(organizationId, entryId, tx, true)
    const entry = await eventTrashEntry(organizationId, entryId, tx)
    if (!state || !entry || (guard.allowed && !guard.allowed(entry))) return false
    const due = (...rest: SQL[]) =>
      and(
        eq(calendarEvents.organizationId, organizationId),
        eq(calendarEvents.trashRoot, entryId),
        isNotNull(calendarEvents.deletedAt),
        guard.trashedBefore ? lt(calendarEvents.deletedAt, guard.trashedBefore) : undefined,
        ...rest,
      )
    const offTrash = { deletedAt: null, deletedBy: null, deletedVia: null, trashRoot: null, trashGuests: null }
    const entryRow = eq(calendarEvents.id, entryId)
    if (entry.seriesId && state.master && stillInSeries(state.master, state.target)) {
      // tenancy: due() names the workspace
      const left = await tx.update(calendarEvents).set(offTrash).where(due(entryRow)).returning({ id: calendarEvents.id })
      return left.length > 0
    }
    if (entry.seriesId) {
      // tenancy: due() names the workspace. The series no longer has this occurrence, so nothing needs to skip it
      const gone = await tx.delete(calendarEvents).where(due(entryRow)).returning({ id: calendarEvents.id })
      return gone.length > 0
    }
    // tenancy: due() names the workspace. Occurrences a split left with the earlier series only leave Trash
    await tx
      .update(calendarEvents)
      .set(offTrash)
      .where(due(ne(calendarEvents.id, entryId), isNotNull(calendarEvents.seriesId), ne(calendarEvents.seriesId, entryId)))
    // tenancy: due() names the workspace
    const gone = await tx.delete(calendarEvents).where(due(entryRow)).returning({ id: calendarEvents.id })
    if (gone.length === 0) return false
    const rooms = [state.target, ...state.overrides].map((row) => `meeting-${row.id}`)
    await tx.delete(meetingParticipants).where(inArray(meetingParticipants.roomName, rooms))
    return true
  })
}

/** Deleted events also lose their meeting room's participant rows. */
async function applyPlan(tx: Tx, organizationId: string, plan: Plan, state: SeriesState): Promise<void> {
  const deleted = new Set(plan.deletes)
  if (state.master && deleted.has(state.master.id)) for (const row of state.overrides) deleted.add(row.id)
  if (plan.inserts.length) await tx.insert(calendarEvents).values(plan.inserts)
  for (const { id, set } of plan.updates) await tx.update(calendarEvents).set(set).where(eq(calendarEvents.id, id))
  if (plan.guestRemoves.length) {
    const byUser = new Map<string, string[]>()
    for (const { eventId, userId } of plan.guestRemoves) byUser.set(userId, [...(byUser.get(userId) ?? []), eventId])
    await tx
      .delete(eventAttendees)
      .where(
        or(...[...byUser].map(([userId, eventIds]) => and(eq(eventAttendees.userId, userId), inArray(eventAttendees.eventId, eventIds)))),
      )
  }
  if (plan.guestAdds.length) {
    await tx.insert(eventAttendees).values(plan.guestAdds.map((guest) => ({ ...guest, organizationId })))
  }
  if (plan.deletes.length) {
    await tx.delete(calendarEvents).where(inArray(calendarEvents.id, plan.deletes))
    await tx.delete(meetingParticipants).where(
      inArray(
        meetingParticipants.roomName,
        [...deleted].map((id) => `meeting-${id}`),
      ),
    )
  }
  const { creatorId, entries } = roomPurge(state, plan)
  const groups = new Map<string, { entry: RoomPurge; rooms: string[] }>()
  for (const entry of entries) {
    const key = [entry.seriesId, entry.keepGuests, entry.userIds?.join(",") ?? "*"].join("|")
    const group = groups.get(key) ?? { entry, rooms: [] }
    group.rooms.push(entry.room)
    groups.set(key, group)
  }
  for (const { entry, rooms } of groups.values()) {
    await tx
      .delete(meetingParticipants)
      .where(
        and(
          inArray(meetingParticipants.roomName, rooms),
          ne(meetingParticipants.userId, creatorId),
          entry.userIds ? inArray(meetingParticipants.userId, entry.userIds) : undefined,
          entry.keepGuests ? notInArray(meetingParticipants.userId, liveSeriesGuests(tx, entry.seriesId)) : undefined,
        ),
      )
  }
}

/**
 * Guests of the live rows of one series: its master and the overrides that are not cancelled. Room
 * access, lobby hosts and the room purge all use this one rule.
 */
function liveSeriesGuests(executor: Executor, seriesId: string, userId?: string) {
  return executor
    .select({ userId: eventAttendees.userId })
    .from(eventAttendees)
    .innerJoin(calendarEvents, eq(calendarEvents.id, eventAttendees.eventId))
    .where(
      and(
        or(eq(calendarEvents.id, seriesId), eq(calendarEvents.seriesId, seriesId)),
        eq(calendarEvents.cancelled, false),
        liveEvent,
        userId ? eq(eventAttendees.userId, userId) : undefined,
      ),
    )
}

/** Sends `calendar-changed` to the users involved, or to the whole org for Everyone events. */
export async function announce(organizationId: string, eventId: string, userIds: Iterable<string>, everyone: boolean): Promise<void> {
  const audience = new Set(userIds)
  calendarPresenceChanged(organizationId, audience)
  if (everyone) for (const id of await orgMemberIds(organizationId)) audience.add(id)
  emitCalendarChanged(organizationId, audience, eventId)
}

/** A sharing change can add, redact or remove the owner's events in anyone's Team view, so the whole org refetches. */
export async function announceSharing(organizationId: string, ownerId: string): Promise<void> {
  const audience = (await orgMemberIds(organizationId)).filter((id) => id !== ownerId)
  emitCalendarChanged(organizationId, audience, "sharing")
  calendarPresenceChanged(organizationId, [ownerId])
}

export async function announcePlan(organizationId: string, actorId: string, state: SeriesState, plan?: Plan) {
  const { userIds, everyone } = audienceOf(state, plan)
  userIds.add(actorId)
  await announce(organizationId, state.master?.id ?? state.target.id, userIds, everyone)
}

/**
 * A reply applies to the whole series: every guest row the viewer has on the master and its overrides, and the kept
 * guest lists of its occurrences in Trash, so a restore brings the reply back current.
 * Returns false when the viewer is a guest of none of them.
 */
export async function respondToSeries(viewerId: string, state: SeriesState, response: string): Promise<boolean> {
  const { organizationId } = state.target
  const masterId = state.master?.id ?? state.target.id
  const inFamily = and(
    eq(calendarEvents.organizationId, organizationId),
    or(eq(calendarEvents.id, masterId), eq(calendarEvents.seriesId, masterId)),
  )
  return db.transaction(async (tx) => {
    // trash: a lock only. The series master comes first, as every series change takes it, and the rows are read after it
    await tx
      .select({ id: calendarEvents.id })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, masterId), eq(calendarEvents.organizationId, organizationId)))
      .for("update")
    // trash: the whole family, as a reply reaches every row the viewer is a guest of
    const family = tx.select({ id: calendarEvents.id }).from(calendarEvents).where(inFamily)
    const replied = await tx
      .update(eventAttendees)
      .set({ response })
      .where(and(eq(eventAttendees.userId, viewerId), inArray(eventAttendees.eventId, family)))
      .returning({ eventId: eventAttendees.eventId })
    const reply = sql`(select jsonb_agg(case when g->>'userId' = ${viewerId} then jsonb_set(g, '{response}', to_jsonb(${response}::text)) else g end order by n) from jsonb_array_elements(${calendarEvents.trashGuests}) with ordinality as t(g, n))`
    const kept = await tx
      .update(calendarEvents)
      .set({ trashGuests: reply })
      .where(
        and(
          inFamily,
          isNotNull(calendarEvents.deletedAt),
          sql`${calendarEvents.trashGuests} @> ${JSON.stringify([{ userId: viewerId }])}::jsonb`,
        ),
      )
      .returning({ id: calendarEvents.id })
    return replied.length + kept.length > 0
  })
}

type SharingDto = {
  default_level: string
  grants: {
    grantee_id: string
    level: string
    grantee: { id: string; first_name: string | null; last_name: string | null; avatar_url: string | null }
  }[]
}

/**
 * Grants to members of the caller's workspace, the one PUT checks grants against. A grant to a user who has left
 * drops out of the list and the next save
 */
export async function getSharing(userId: string, organizationId: string): Promise<SharingDto> {
  const [row, grants] = await Promise.all([
    db.query.calendarSharing.findFirst({ where: eq(calendarSharing.userId, userId) }),
    db
      .select({
        granteeId: calendarShareGrants.granteeId,
        level: calendarShareGrants.level,
        firstName: users.firstName,
        lastName: users.lastName,
        avatarUrl: users.avatarUrl,
      })
      .from(calendarShareGrants)
      .innerJoin(users, eq(users.id, calendarShareGrants.granteeId))
      .where(
        and(
          eq(calendarShareGrants.ownerId, userId),
          inArray(calendarShareGrants.granteeId, memberIdsOf(organizationId)),
          eq(calendarShareGrants.organizationId, organizationId),
        ),
      )
      .orderBy(asc(calendarShareGrants.createdAt)),
  ])
  return {
    default_level: row?.defaultLevel ?? DEFAULT_SHARE_LEVEL,
    grants: grants.map((grant) => ({
      grantee_id: grant.granteeId,
      level: grant.level,
      grantee: { id: grant.granteeId, first_name: grant.firstName, last_name: grant.lastName, avatar_url: grant.avatarUrl },
    })),
  }
}

/** Omitted parts stay as they are. Grants replace the whole list, one per grantee. */
export async function saveSharing(
  userId: string,
  organizationId: string,
  input: { default_level?: ShareLevel; grants?: { grantee_id: string; level: GrantLevel }[] },
): Promise<void> {
  const now = new Date().toISOString()
  await db.transaction(async (tx) => {
    if (input.default_level) {
      await tx
        .insert(calendarSharing)
        .values({ userId, defaultLevel: input.default_level, updatedAt: now })
        .onConflictDoUpdate({ target: calendarSharing.userId, set: { defaultLevel: input.default_level, updatedAt: now } })
    }
    if (input.grants) {
      const byGrantee = new Map(input.grants.map((grant) => [grant.grantee_id, grant.level]))
      await tx
        .delete(calendarShareGrants)
        .where(and(eq(calendarShareGrants.ownerId, userId), eq(calendarShareGrants.organizationId, organizationId)))
      if (byGrantee.size) {
        await tx
          .insert(calendarShareGrants)
          .values([...byGrantee].map(([granteeId, level]) => ({ ownerId: userId, granteeId, level, organizationId })))
      }
    }
  })
}

/**
 * The series behind `meeting-{eventId}` and whether its room is open, decided across the live rows of
 * the series as `seriesRoom` does. Null when the event is gone.
 */
export async function eventRoomState(
  eventId: string,
  organizationId?: string,
): Promise<{ masterId: string; organizationId: string; creatorId: string; title: string; video: boolean; everyone: boolean } | null> {
  const row = await db.query.calendarEvents.findFirst({
    where: and(eq(calendarEvents.id, eventId), organizationId ? eq(calendarEvents.organizationId, organizationId) : undefined, liveEvent),
    columns: { id: true, seriesId: true, organizationId: true },
  })
  if (!row) return null
  const masterId = row.seriesId ?? row.id
  const family = await db
    .select({
      id: calendarEvents.id,
      seriesId: calendarEvents.seriesId,
      createdBy: calendarEvents.createdBy,
      title: calendarEvents.title,
      videoCall: calendarEvents.videoCall,
      everyone: calendarEvents.everyone,
      cancelled: calendarEvents.cancelled,
    })
    .from(calendarEvents)
    .where(and(or(eq(calendarEvents.id, masterId), eq(calendarEvents.seriesId, masterId)), liveEvent))
  const master = family.find((item) => item.id === masterId)
  if (!master) return null
  return { masterId, organizationId: row.organizationId, creatorId: master.createdBy, title: master.title, ...seriesRoom(family, masterId) }
}

/**
 * Who may enter `meeting-{eventId}`, the room of the whole series while any live row has a video call:
 * the creator, a guest of any live row, and any member when a live row is an Everyone event.
 */
export async function eventRoomAccess(userId: string, organizationId: string, eventId: string): Promise<boolean> {
  const room = await eventRoomState(eventId, organizationId)
  if (!room?.video) return false
  if (room.creatorId === userId || room.everyone) return true
  return (await liveSeriesGuests(db, room.masterId, userId).limit(1)).length > 0
}

/**
 * The creator and every guest of the live rows of the series, who hear about guests waiting in its
 * room's lobby. `everyone` says whether any member may enter.
 */
export async function eventRoomHosts(eventId: string): Promise<{ hosts: string[]; everyone: boolean; organizationId: string | null }> {
  const room = await eventRoomState(eventId)
  if (!room || room.masterId !== eventId) return { hosts: [], everyone: false, organizationId: null }
  const guests = await liveSeriesGuests(db, room.masterId)
  const hosts = [...new Set([room.creatorId, ...guests.map((guest) => guest.userId)])]
  return { hosts, everyone: room.everyone, organizationId: room.organizationId }
}
