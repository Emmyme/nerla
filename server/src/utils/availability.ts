import { DAY_MS, fromWallClock, isValidTimeZone, wallClock } from "./eventTime"
import type { Visibility } from "./eventVisibility"

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
export type Weekday = (typeof WEEKDAYS)[number]
export type DayHours = { start: string; end: string }
export type WorkingHours = Partial<Record<Weekday, DayHours>>

export type AvailabilityKind = "ooo" | "busy" | "meeting" | "focus" | "off_hours"
/** `until` is an ISO instant, or a YYYY-MM-DD last day for an all-day out of office. */
export type Availability = { kind: AvailabilityKind | null; until?: string; note?: string }

export type AvailabilityEvent = {
  startMs: number
  endMs: number
  allDay: boolean
  eventType: string
  title: string
  visibility: Visibility
}

const NONE: Availability = { kind: null }
// Titles that only repeat the state say nothing more
const PLAIN_TITLES = new Set(["", "out of office", "(no title)"])

/** Minutes since midnight of an "HH:MM" time */
export const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The weekday of a wall time given as milliseconds of a UTC date */
export const weekdayOf = (wallMs: number): Weekday => WEEKDAYS[(new Date(wallMs).getUTCDay() + 6) % 7]

function nextStart(nowMs: number, hours: WorkingHours, timeZone: string): number | null {
  const wall = wallClock(nowMs, timeZone)
  const midnight = Math.floor(wall / DAY_MS) * DAY_MS
  const minute = Math.floor((wall - midnight) / 60_000)
  const today = hours[weekdayOf(wall)]
  if (today && minute >= minutesOf(today.start) && minute < minutesOf(today.end)) return null
  for (let offset = 0; offset <= 7; offset++) {
    const day = midnight + offset * DAY_MS
    const range = hours[weekdayOf(day)]
    if (!range) continue
    const start = minutesOf(range.start)
    if (offset === 0 && minute >= start) continue
    return fromWallClock(day + start * 60_000, timeZone)
  }
  return null
}

function workdayEnd(nowMs: number, hours: WorkingHours, timeZone: string): number | null {
  const wall = wallClock(nowMs, timeZone)
  const midnight = Math.floor(wall / DAY_MS) * DAY_MS
  const minute = Math.floor((wall - midnight) / 60_000)
  const today = hours[weekdayOf(wall)]
  if (!today || minute < minutesOf(today.start) || minute >= minutesOf(today.end)) return null
  return fromWallClock(midnight + minutesOf(today.end) * 60_000, timeZone)
}

type AvailabilityInput = {
  nowMs: number
  events: AvailabilityEvent[]
  workingHours: WorkingHours | null
  timeZone: string | null
}

/**
 * The next instant after now when `availabilityOf` could give something else: an event that counts starts
 * or ends, or working hours begin or end. Undefined when none of those is coming.
 */
export function availabilityChangesAt({ nowMs, events, workingHours, timeZone }: AvailabilityInput): number | undefined {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC"
  const instant = (event: AvailabilityEvent, ms: number) => (event.allDay ? fromWallClock(ms, zone) : ms)
  const times: number[] = []
  for (const event of events) {
    if (event.eventType !== "ooo" && (event.allDay || event.visibility === "hidden")) continue
    times.push(instant(event, event.startMs), instant(event, event.endMs))
  }
  if (workingHours && timeZone && isValidTimeZone(timeZone) && Object.keys(workingHours).length > 0) {
    const edge = nextStart(nowMs, workingHours, timeZone) ?? workdayEnd(nowMs, workingHours, timeZone)
    if (edge !== null) times.push(edge)
  }
  const ahead = times.filter((time) => time > nowMs)
  return ahead.length ? Math.min(...ahead) : undefined
}

/**
 * What the user is up to now, in this order: out of office, busy from a calendar event the viewer
 * may see, outside working hours, or nothing. All-day dates are read in the user's own zone.
 */
export function availabilityOf({ nowMs, events, workingHours, timeZone }: AvailabilityInput): Availability {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC"
  const today = Math.floor(wallClock(nowMs, zone) / DAY_MS) * DAY_MS
  const endInstant = (event: AvailabilityEvent) => (event.allDay ? fromWallClock(event.endMs, zone) : event.endMs)
  const covers = (event: AvailabilityEvent) =>
    event.allDay ? event.startMs <= today && today < event.endMs : event.startMs <= nowMs && nowMs < event.endMs
  const latest = (list: AvailabilityEvent[]) =>
    list.reduce<AvailabilityEvent | null>((best, event) => (!best || endInstant(event) > endInstant(best) ? event : best), null)

  const away = latest(events.filter((event) => event.eventType === "ooo" && covers(event)))
  if (away) {
    const title = away.visibility === "full" ? away.title.trim() : ""
    const note = PLAIN_TITLES.has(title.toLowerCase()) ? "" : title
    return {
      kind: "ooo",
      until: away.allDay ? dateOf(away.endMs - DAY_MS) : new Date(away.endMs).toISOString(),
      ...(note ? { note } : {}),
    }
  }

  const busy = latest(
    events.filter((event) => event.eventType !== "ooo" && !event.allDay && event.visibility !== "hidden" && covers(event)),
  )
  if (busy) {
    const shown = busy.visibility === "full"
    const kind = shown && busy.eventType === "meeting" ? "meeting" : shown && busy.eventType === "focus" ? "focus" : "busy"
    return { kind, until: new Date(busy.endMs).toISOString() }
  }

  if (workingHours && timeZone && isValidTimeZone(timeZone) && Object.keys(workingHours).length > 0) {
    const back = nextStart(nowMs, workingHours, timeZone)
    if (back !== null) return { kind: "off_hours", until: new Date(back).toISOString() }
  }
  return NONE
}
