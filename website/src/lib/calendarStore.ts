import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import { moveEvent, wallDelta } from "@/components/calendar/timeMath"
import { calendarAPI } from "@/lib/api/calendar"
import type { CalendarEntry, CalendarEvent, EventCreateBody, EventPatch, EventResponse, RecurrenceScope } from "@/lib/api/calendar"
import type { TrashRef } from "@/lib/api/trash"
import { addDays, allDayRange, parseServerDate, startOfWeek } from "@/lib/dates"
import { onCalendarChanged, onSocketReconnect } from "@/lib/socket"
import { messageOf, SAVE_FAILED } from "@/lib/taskStore"

type CalendarStatus = "loading" | "ready" | "error"

export type EventMutation =
  | { type: "create"; body: EventCreateBody; userId: string }
  | { type: "update"; event: CalendarEvent; patch: EventPatch; scope?: RecurrenceScope }
  | { type: "delete"; event: CalendarEvent; scope?: RecurrenceScope; onTrashed?: (entry: TrashRef) => void }
  | { type: "respond"; event: CalendarEvent; response: Exclude<EventResponse, "pending">; userId: string }

const RELOAD_WINDOW_MS = 300
// The server answers at most 120 days per request
const MAX_RUN_WEEKS = 17
const MAX_TEAM_USERS = 20
const MAX_CACHED_WEEKS = 40
const MAX_CACHED_TEAM = 400
const ECHO_MS = 10_000
const LOAD_FAILED = "Couldn't load the calendar. Check your connection and try again."

type Chunk<E> = { events: E[] | null; error: string | null; request: number; loading: boolean; stale: boolean; usedAt: number }
type TeamChunk = Chunk<CalendarEntry> & { shared: boolean }
type DeleteMutation = Extract<EventMutation, { type: "delete" }>
/** A create keeps its save, so a delete while it saves can wait for the id. `dropped` keeps the saved copy off the calendar */
type Op = {
  seq: number
  mutation: EventMutation
  temp?: CalendarEvent
  saving?: Promise<CalendarEvent | { id: string }>
  dropped?: boolean
}

const mine = new Map<number, Chunk<CalendarEvent>>()
const team = new Map<string, TeamChunk>()
const mineWatch = new Map<number, number>()
const teamWatch = new Map<string, number>()
const echoes = new Map<string, number>()
const deferred = new Set<string>()
const listeners = new Set<() => void>()
let pending: Op[] = []
let inFlight = 0
let version = 0
let requestSeq = 0
let mutationSeq = 0
let reloadTimer: ReturnType<typeof setTimeout> | undefined
let stopSocket: (() => void) | undefined

function publish() {
  version += 1
  listeners.forEach((listener) => listener())
}

const getVersion = () => version

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    window.addEventListener("focus", scheduleReload)
    const stops = [onCalendarChanged(({ eventId }) => onChanged(eventId)), onSocketReconnect(scheduleReload)]
    stopSocket = () => stops.forEach((stop) => stop())
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    window.removeEventListener("focus", scheduleReload)
    stopSocket?.()
    stopSocket = undefined
    clearTimeout(reloadTimer)
    reloadTimer = undefined
  }
}

/** Stable per occurrence and per calendar. Busy ids are opaque, and their start keeps the key unique all the same. */
export function entryKey(entry: CalendarEntry): string {
  return entry.busy ? `${entry.calendar_user_id}:${entry.id}@${entry.starts_at}` : `${entry.calendar_user_id}:${entry.occurrence_id}`
}

const ms = (value: string | null | undefined) => parseServerDate(value)?.getTime() ?? 0

function spanOf(entry: CalendarEntry): [number, number] | null {
  if (entry.all_day) {
    const range = allDayRange(entry)
    return range && [range.first.getTime(), addDays(range.last, 1).getTime()]
  }
  const start = parseServerDate(entry.starts_at)
  if (!start) return null
  return [start.getTime(), Math.max(ms(entry.ends_at), start.getTime() + 1)]
}

function overlapsRange(entry: CalendarEntry, from: number, to: number): boolean {
  const span = spanOf(entry)
  return !!span && span[0] < to && span[1] > from
}

const byStart = (a: CalendarEntry, b: CalendarEntry) =>
  Number(b.all_day) - Number(a.all_day) || ms(a.starts_at) - ms(b.starts_at) || ms(a.ends_at) - ms(b.ends_at)

const stampOf = (entry: CalendarEntry) => (entry.busy ? 0 : ms(entry.updated_at))

// A reload that answers late must not bring back an older copy than the one a save already returned
function mergeNewest<E extends CalendarEntry>(incoming: E[], shown: E[] | null): E[] {
  if (!shown) return incoming
  const byKey = new Map(shown.map((entry) => [entryKey(entry), entry]))
  return incoming.map((entry) => {
    const current = byKey.get(entryKey(entry))
    return current && stampOf(current) > stampOf(entry) ? current : entry
  })
}

function weeksOf(from: number, to: number): number[] {
  const weeks: number[] = []
  for (let week = startOfWeek(new Date(from)); week.getTime() < to; week = addDays(week, 7)) weeks.push(week.getTime())
  return weeks.length ? weeks : [startOfWeek(new Date(from)).getTime()]
}

const weekEnd = (week: number) => addDays(new Date(week), 7).getTime()
const parseKey = (key: string) => (key ? key.split(",") : [])
const teamKey = (week: number, user: string) => `${week}|${user}`

// Consecutive weeks that need the same request become one run
function runsOf<T>(weeks: [number, T][], same: (a: T, b: T) => boolean): [number[], T][] {
  const runs: [number[], T][] = []
  for (const [week, value] of [...weeks].sort((a, b) => a[0] - b[0])) {
    const last = runs[runs.length - 1]
    const lastWeek = last?.[0][last[0].length - 1]
    if (last && lastWeek !== undefined && weekEnd(lastWeek) === week && last[0].length < MAX_RUN_WEEKS && same(last[1], value))
      last[0].push(week)
    else runs.push([[week], value])
  }
  return runs
}

function blank<E>(): Chunk<E> {
  return { events: null, error: null, request: 0, loading: false, stale: false, usedAt: Date.now() }
}

function needsFetch(chunk: Chunk<unknown> | undefined, force: boolean): boolean {
  if (!chunk) return true
  if (force) return true
  return !chunk.loading && (chunk.events === null || chunk.stale)
}

function evict<K, C extends Chunk<unknown>>(cache: Map<K, C>, watched: Map<K, number>, max: number) {
  if (cache.size <= max) return
  const idle = [...cache.entries()].filter(([key]) => !watched.get(key)).sort((a, b) => a[1].usedAt - b[1].usedAt)
  for (const [key] of idle.slice(0, cache.size - max)) cache.delete(key)
}

/**
 * Resolves false when any part of the load failed. `quiet` leaves the publish to the caller, so a save can swap its
 * optimistic copy for the server's in one step
 */
async function fetchMine(weeks: number[], force: boolean, quiet = false): Promise<boolean> {
  const need = weeks.filter((week) => needsFetch(mine.get(week), force))
  if (need.length === 0) return true
  let ok = true
  const runs = runsOf(
    need.map((week) => [week, null] as [number, null]),
    () => true,
  )
  await Promise.all(
    runs.map(async ([run]) => {
      const id = ++requestSeq
      for (const week of run) {
        const chunk = mine.get(week) ?? blank<CalendarEvent>()
        mine.set(week, { ...chunk, request: id, loading: true })
      }
      publish()
      const start = new Date(run[0]).toISOString()
      const end = new Date(weekEnd(run[run.length - 1])).toISOString()
      try {
        const events = await calendarAPI.getRange(start, end)
        for (const week of run) {
          const chunk = mine.get(week)
          if (!chunk || chunk.request !== id) continue
          const inWeek = events.filter((event) => overlapsRange(event, week, weekEnd(week)))
          mine.set(week, { ...chunk, events: mergeNewest(inWeek, chunk.events), error: null, loading: false, stale: false })
        }
      } catch (err) {
        ok = false
        for (const week of run) {
          const chunk = mine.get(week)
          if (chunk?.request === id) mine.set(week, { ...chunk, error: messageOf(err, LOAD_FAILED), loading: false })
        }
      }
      evict(mine, mineWatch, MAX_CACHED_WEEKS)
      if (!quiet) publish()
    }),
  )
  return ok
}

async function fetchTeam(weeks: number[], users: string[], force: boolean): Promise<void> {
  const need = weeks.map((week) => [week, users.filter((user) => needsFetch(team.get(teamKey(week, user)), force))] as [number, string[]])
  const runs = runsOf(need, (a, b) => a.join(",") === b.join(",")).filter(([, people]) => people.length > 0)
  const batches = runs.flatMap(([run, people]) =>
    Array.from(
      { length: Math.ceil(people.length / MAX_TEAM_USERS) },
      (_, i) => [run, people.slice(i * MAX_TEAM_USERS, (i + 1) * MAX_TEAM_USERS)] as const,
    ),
  )
  if (batches.length === 0) return
  await Promise.all(
    batches.map(async ([run, people]) => {
      const id = ++requestSeq
      for (const week of run) {
        for (const user of people) {
          const chunk = team.get(teamKey(week, user)) ?? { ...blank<CalendarEntry>(), shared: true }
          team.set(teamKey(week, user), { ...chunk, request: id, loading: true })
        }
      }
      publish()
      const start = new Date(run[0]).toISOString()
      const end = new Date(weekEnd(run[run.length - 1])).toISOString()
      try {
        const calendars = await calendarAPI.getTeamRange(start, end, people)
        for (const week of run) {
          for (const user of people) {
            const key = teamKey(week, user)
            const chunk = team.get(key)
            if (!chunk || chunk.request !== id) continue
            const list = calendars[user]
            const inWeek = (list ?? []).filter((entry) => overlapsRange(entry, week, weekEnd(week)))
            team.set(key, {
              ...chunk,
              events: mergeNewest(inWeek, chunk.events),
              shared: list !== undefined,
              error: null,
              loading: false,
              stale: false,
            })
          }
        }
      } catch (err) {
        for (const week of run) {
          for (const user of people) {
            const chunk = team.get(teamKey(week, user))
            if (chunk?.request === id) team.set(teamKey(week, user), { ...chunk, error: messageOf(err, LOAD_FAILED), loading: false })
          }
        }
      }
      evict(team, teamWatch, MAX_CACHED_TEAM)
      publish()
    }),
  )
}

function markStale() {
  for (const [week, chunk] of mine) mine.set(week, { ...chunk, stale: true })
  for (const [key, chunk] of team) team.set(key, { ...chunk, stale: true })
}

function reloadWatched(quiet = false): Promise<boolean> {
  markStale()
  const mineDone = fetchMine([...mineWatch.keys()], true, quiet)
  const byUser = new Map<string, number[]>()
  for (const key of teamWatch.keys()) {
    const [week, user] = key.split("|")
    byUser.set(user, [...(byUser.get(user) ?? []), Number(week)])
  }
  const weeks = [...new Set([...byUser.values()].flat())]
  const teamDone = weeks.length ? fetchTeam(weeks, [...byUser.keys()], true) : Promise.resolve()
  return Promise.all([mineDone, teamDone]).then(([ok]) => ok)
}

/** Reloads what is on screen now, the user's calendar and Team view, as after a change to who shares what */
export function refreshCalendar(): Promise<boolean> {
  return reloadWatched()
}

// Focus and calendar changes within the window become one reload of what is on screen. The cache is
// marked stale at once, so the reload still happens on the next mount if the page unmounts first.
function scheduleReload() {
  markStale()
  if (reloadTimer !== undefined) return
  reloadTimer = setTimeout(() => {
    reloadTimer = undefined
    void reloadWatched()
  }, RELOAD_WINDOW_MS)
}

// A reload sent before the save committed may answer after it and undo a create or a delete
function loadingSince(request: number): boolean {
  for (const [week, chunk] of mine) if (mineWatch.has(week) && chunk.loading && chunk.request <= request) return true
  return false
}

function consumeEcho(eventId: string): boolean {
  const expires = echoes.get(eventId)
  echoes.delete(eventId)
  return expires !== undefined && expires > Date.now()
}

// The server also tells the user who made a change. This store already holds that copy, so it skips its own echo.
function onChanged(eventId: string) {
  if (inFlight > 0) {
    deferred.add(eventId)
    return
  }
  if (!consumeEcho(eventId)) scheduleReload()
}

function expectEcho(ids: (string | null | undefined)[]) {
  const until = Date.now() + ECHO_MS
  for (const id of ids) if (id) echoes.set(id, until)
}

function watch<K>(watched: Map<K, number>, keys: K[], touch: (key: K) => void): () => void {
  for (const key of keys) {
    watched.set(key, (watched.get(key) ?? 0) + 1)
    touch(key)
  }
  return () => {
    for (const key of keys) {
      const count = (watched.get(key) ?? 1) - 1
      if (count > 0) watched.set(key, count)
      else watched.delete(key)
    }
  }
}

function touchChunk<K, C extends Chunk<unknown>>(cache: Map<K, C>) {
  return (key: K) => {
    const chunk = cache.get(key)
    if (chunk) chunk.usedAt = Date.now()
  }
}

function statusOf(chunks: (Chunk<unknown> | undefined)[]): { status: CalendarStatus; error: string | null } {
  const missing = chunks.filter((chunk) => !chunk || chunk.events === null)
  const failed = missing.find((chunk) => chunk?.error && !chunk.loading)
  if (failed) return { status: "error", error: failed.error }
  return { status: missing.length ? "loading" : "ready", error: null }
}

function newest<E extends CalendarEntry>(lists: (E[] | null | undefined)[]): E[] {
  const union = new Map<string, E>()
  for (const list of lists) {
    for (const entry of list ?? []) {
      const key = entryKey(entry)
      const shown = union.get(key)
      if (!shown || stampOf(entry) > stampOf(shown)) union.set(key, entry)
    }
  }
  return [...union.values()]
}

// --- Optimistic changes ---

const EDITABLE = [
  "title",
  "description",
  "location",
  "all_day",
  "event_type",
  "video_call",
  "everyone",
  "recurrence_rule",
  "recurrence_tz",
  "reminder_minutes",
] as const

function scopeOf(event: CalendarEvent, scope: RecurrenceScope | undefined): RecurrenceScope | undefined {
  return event.series_id ? (scope ?? "this") : undefined
}

function affects(target: CalendarEvent, scope: RecurrenceScope | undefined, entry: CalendarEvent): boolean {
  const effective = scopeOf(target, scope)
  if (!effective || effective === "this") return entry.occurrence_id === target.occurrence_id
  if (entry.series_id !== target.series_id) return false
  return effective === "all" || ms(entry.original_start) >= ms(target.original_start)
}

// Other occurrences move like the edited one, by whole dates at the same wall-clock time, then by minutes
function patched(target: CalendarEvent, patch: EventPatch, entry: CalendarEvent): CalendarEvent {
  const next: CalendarEvent = { ...entry }
  for (const field of EDITABLE) if (patch[field] !== undefined) Object.assign(next, { [field]: patch[field] })
  if (patch.starts_at !== undefined || patch.ends_at !== undefined) {
    const from = parseServerDate(target.starts_at)
    const start = parseServerDate(patch.starts_at ?? target.starts_at)
    const end = parseServerDate(patch.ends_at ?? target.ends_at)
    if (!from || !start || !end) return next
    const { days, minutes } = wallDelta(from, start, target.all_day)
    const moved = moveEvent({ starts_at: entry.starts_at, ends_at: entry.starts_at, all_day: target.all_day }, minutes, days).starts_at
    next.starts_at = moved
    next.ends_at = new Date(ms(moved) + (end.getTime() - start.getTime())).toISOString()
  }
  return next
}

// A reply counts for every occurrence of the series, as the server saves it
function responded(entry: CalendarEvent, response: EventResponse, userId: string): CalendarEvent {
  return {
    ...entry,
    viewer_response: response,
    attendees: entry.attendees.map((guest) => (guest.user_id === userId ? { ...guest, response } : guest)),
  }
}

function withPending(list: CalendarEvent[]): CalendarEvent[] {
  let out = list
  for (const { mutation, temp } of pending) {
    if (mutation.type === "create") {
      if (temp) out = [...out, temp]
    } else if (mutation.type === "respond") {
      const { event, response, userId } = mutation
      out = out.map((entry) => (affects(event, "all", entry) ? responded(entry, response, userId) : entry))
    } else if (mutation.type === "update") {
      out = out.map((entry) => (affects(mutation.event, mutation.scope, entry) ? patched(mutation.event, mutation.patch, entry) : entry))
    } else {
      out = out.filter((entry) => !affects(mutation.event, mutation.scope, entry))
    }
  }
  return out
}

// Team view shows a teammate's event as it is being changed, as the user's own calendar does
function withPendingTeam(list: CalendarEntry[]): CalendarEntry[] {
  let out = list
  for (const { mutation } of pending) {
    if (mutation.type === "update") {
      out = out.map((entry) =>
        !entry.busy && affects(mutation.event, mutation.scope, entry) ? patched(mutation.event, mutation.patch, entry) : entry,
      )
    } else if (mutation.type === "delete") {
      out = out.filter((entry) => entry.busy || !affects(mutation.event, mutation.scope, entry))
    }
  }
  return out
}

function tempEvent(seq: number, { body, userId }: { body: EventCreateBody; userId: string }): CalendarEvent {
  const now = new Date().toISOString()
  return {
    id: `temp-${seq}`,
    occurrence_id: `temp-${seq}`,
    series_id: null,
    original_start: null,
    title: body.title,
    description: body.description ?? null,
    location: body.location ?? null,
    starts_at: body.starts_at,
    ends_at: body.ends_at,
    all_day: body.all_day ?? false,
    event_type: body.event_type ?? "event",
    video_call: body.video_call ?? body.event_type === "meeting",
    everyone: body.everyone ?? false,
    recurrence_rule: body.recurrence_rule ?? null,
    recurrence_tz: body.recurrence_tz ?? null,
    reminder_minutes: body.reminder_minutes ?? null,
    created_by: userId,
    organizer: { id: userId, first_name: null, last_name: null, avatar_url: null },
    calendar_user_id: userId,
    attendees: [],
    viewer_response: null,
    created_at: now,
    updated_at: now,
  }
}

function writeMine(update: (events: CalendarEvent[], week: number) => CalendarEvent[]) {
  for (const [week, chunk] of mine) if (chunk.events) mine.set(week, { ...chunk, events: update(chunk.events, week) })
}

function storeSaved(saved: CalendarEvent, replaces: string) {
  const key = entryKey(saved)
  writeMine((events, week) => {
    const rest = events.filter((entry) => entryKey(entry) !== key && entryKey(entry) !== replaces)
    return overlapsRange(saved, week, weekEnd(week)) ? [...rest, saved] : rest
  })
}

function writeTeam(update: (events: CalendarEntry[]) => CalendarEntry[]) {
  for (const [key, chunk] of team) if (chunk.events) team.set(key, { ...chunk, events: update(chunk.events) })
}

// Every teammate's calendar that shows the occurrence gets the saved copy in each cached week it now overlaps
function storeSavedTeam(saved: CalendarEvent, replaces: string) {
  const isIt = (entry: CalendarEntry) => !entry.busy && (entry.occurrence_id === replaces || entry.occurrence_id === saved.occurrence_id)
  const people = new Set<string>()
  for (const chunk of team.values()) for (const entry of chunk.events ?? []) if (isIt(entry)) people.add(entry.calendar_user_id)
  for (const [key, chunk] of team) {
    const [week, user] = key.split("|")
    if (!chunk.events || !people.has(user)) continue
    const copy = { ...saved, calendar_user_id: user }
    const rest = chunk.events.filter((entry) => !isIt(entry))
    team.set(key, { ...chunk, events: overlapsRange(copy, Number(week), weekEnd(Number(week))) ? [...rest, copy] : rest })
  }
}

function onMyCalendar(event: CalendarEvent): boolean {
  for (const chunk of mine.values()) if (chunk.events?.some((entry) => entry.occurrence_id === event.occurrence_id)) return true
  return false
}

const isFull = (value: unknown): value is CalendarEvent => typeof value === "object" && value !== null && "occurrence_id" in value

function teamShows(ids: string[]): boolean {
  for (const chunk of team.values()) if (chunk.events?.some((entry) => ids.includes(entry.id))) return true
  return false
}

function settle(op: Op) {
  pending = pending.filter((other) => other !== op)
  inFlight -= 1
  if (inFlight > 0 || deferred.size === 0) return
  const ids = [...deferred]
  deferred.clear()
  if (ids.filter((id) => !consumeEcho(id)).length > 0) scheduleReload()
}

/**
 * A `temp-` id never reaches the server. The event leaves the calendar at once, and once its save returns the saved
 * event is deleted. A failed save leaves nothing to delete, and a create that already settled has swapped or dropped it
 */
async function deleteUnsaved(mutation: DeleteMutation): Promise<string | null> {
  const creating = pending.find((op) => op.mutation.type === "create" && `temp-${op.seq}` === mutation.event.id)
  if (!creating?.saving) return null
  creating.dropped = true
  creating.temp = undefined
  publish()
  const saved = await creating.saving.catch(() => null)
  if (!saved) return null
  return mutateEvent({ ...mutation, event: isFull(saved) ? saved : { ...mutation.event, id: saved.id }, scope: "all" })
}

/**
 * Optimistic create, update and delete. The change shows at once, holds through refetches, and is
 * rolled back if the server refuses it. Resolves with the message to show, or null when it saved.
 * Edits that touch more than one occurrence reload what is on screen after saving.
 */
export async function mutateEvent(mutation: EventMutation): Promise<string | null> {
  if (mutation.type === "delete" && mutation.event.id.startsWith("temp-")) return deleteUnsaved(mutation)
  const seq = ++mutationSeq
  const op: Op = { seq, mutation, temp: mutation.type === "create" ? tempEvent(seq, mutation) : undefined }
  pending = [...pending, op]
  inFlight += 1
  publish()
  try {
    let reload = false
    let ids: (string | null | undefined)[] = []
    if (mutation.type === "create") {
      op.saving = calendarAPI.createEvent(mutation.body)
      const saved = await op.saving
      // The saved copy takes the placeholder's slot at once, so a reload still pending never shows both
      if (isFull(saved) && !op.dropped) {
        storeSaved(saved, "")
        op.temp = undefined
      }
      reload = !op.dropped && (!!mutation.body.recurrence_rule || !isFull(saved))
      ids = [saved.id]
    } else if (mutation.type === "respond") {
      const { event } = mutation
      const saved = await calendarAPI.respond(event.id, mutation.response)
      ids = [event.id, event.series_id]
      if (!event.series_id && isFull(saved)) storeSaved(saved, entryKey(event))
      else reload = true
    } else {
      const { event } = mutation
      const scope = scopeOf(event, mutation.scope)
      const where = scope ? { scope, occurrence: event.original_start } : undefined
      ids = [event.id, event.series_id]
      if (mutation.type === "update") {
        const saved = await calendarAPI.updateEvent(event.id, mutation.patch, where)
        const single = !scope || scope === "this"
        const reshaped = "recurrence_rule" in mutation.patch || (isFull(saved) && saved.series_id !== event.series_id)
        if (single && !reshaped && isFull(saved)) {
          // A teammate's event saved by an admin stays in Team view and never joins the admin's own calendar
          if (onMyCalendar(event)) storeSaved(saved, entryKey(event))
          storeSavedTeam(saved, event.occurrence_id)
        } else reload = true
        ids.push(saved.id)
      } else {
        const entry = await calendarAPI.deleteEvent(event.id, where)
        mutation.onTrashed?.(entry)
        writeMine((events) => events.filter((entry) => !affects(event, mutation.scope, entry)))
        writeTeam((events) => events.filter((entry) => entry.busy || !affects(event, mutation.scope, entry)))
      }
    }
    expectEcho(ids)
    const answered = requestSeq
    // The optimistic copy stays until the server's copy of every changed occurrence is in, so nothing snaps back
    const reloaded = reload ? await reloadWatched(true) : true
    settle(op)
    const retry = !reloaded || (!reload && loadingSince(answered))
    if (retry || teamShows(ids.filter((id): id is string => !!id))) scheduleReload()
    publish()
    return null
  } catch (err) {
    settle(op)
    publish()
    scheduleReload()
    // The user deleted the event while it saved, so its failed save is nothing to report
    return op.dropped ? null : messageOf(err, SAVE_FAILED)
  }
}

// --- Hooks ---

/**
 * The user's calendar between two instants. Whole weeks are fetched and cached, so moving within a cached
 * week costs nothing, and the events array keeps its identity until something in the store changes.
 */
export function useCalendarRange(from: Date, to: Date) {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  const current = useSyncExternalStore(subscribe, getVersion, getVersion)
  const weeksKey = weeksOf(fromMs, toMs).join(",")

  useEffect(() => {
    const weeks = parseKey(weeksKey).map(Number)
    const release = watch(mineWatch, weeks, touchChunk(mine))
    void fetchMine(weeks, false)
    return release
  }, [weeksKey])

  const reload = useCallback(() => fetchMine(parseKey(weeksKey).map(Number), true).then(() => undefined), [weeksKey])

  const state = useMemo(() => {
    void current
    const chunks = parseKey(weeksKey).map((week) => mine.get(Number(week)))
    const events = withPending(newest(chunks.map((chunk) => chunk?.events)))
      .filter((event) => overlapsRange(event, fromMs, toMs))
      .sort(byStart)
    return { events, ...statusOf(chunks) }
  }, [current, weeksKey, fromMs, toMs])

  return { ...state, reload }
}

/**
 * Team view for the selected users, one request per range for everyone not cached yet. Users
 * whose sharing is private come back in `unshared`.
 */
export function useTeamRange(from: Date, to: Date, userIds: string[]) {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  const current = useSyncExternalStore(subscribe, getVersion, getVersion)
  const weeksKey = weeksOf(fromMs, toMs).join(",")
  const usersKey = [...new Set(userIds)].sort().join(",")

  useEffect(() => {
    const weeks = parseKey(weeksKey).map(Number)
    const users = parseKey(usersKey)
    if (users.length === 0) return
    const keys = weeks.flatMap((week) => users.map((user) => teamKey(week, user)))
    const release = watch(teamWatch, keys, touchChunk(team))
    void fetchTeam(weeks, users, false)
    return release
  }, [weeksKey, usersKey])

  const reload = useCallback(() => {
    const users = parseKey(usersKey)
    return users.length ? fetchTeam(parseKey(weeksKey).map(Number), users, true) : Promise.resolve()
  }, [weeksKey, usersKey])

  const state = useMemo(() => {
    void current
    const weeks = parseKey(weeksKey).map(Number)
    const byUser: Record<string, CalendarEntry[]> = {}
    const unshared: string[] = []
    const all: (TeamChunk | undefined)[] = []
    for (const user of parseKey(usersKey)) {
      const chunks = weeks.map((week) => team.get(teamKey(week, user)))
      all.push(...chunks)
      if (chunks.some((chunk) => chunk?.events && !chunk.shared)) {
        unshared.push(user)
        continue
      }
      byUser[user] = withPendingTeam(newest(chunks.map((chunk) => chunk?.events)))
        .filter((entry) => overlapsRange(entry, fromMs, toMs))
        .sort(byStart)
    }
    return { events: Object.values(byUser).flat(), byUser, unshared, ...statusOf(all) }
  }, [current, weeksKey, usersKey, fromMs, toMs])

  return { ...state, reload }
}

export function resetCalendarStore() {
  requestSeq += 1
  mine.clear()
  team.clear()
  mineWatch.clear()
  teamWatch.clear()
  echoes.clear()
  deferred.clear()
  pending = []
  inFlight = 0
  clearTimeout(reloadTimer)
  reloadTimer = undefined
}
