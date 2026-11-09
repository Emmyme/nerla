import { minutesOf, WEEKDAYS, weekdayOf, type DayHours, type Weekday, type WorkingHours } from "./availability"
import { DAY_MS, fromWallClock, isValidTimeZone, wallClock } from "./eventTime"

export const FREE_MAX_PEOPLE = 20
export const FREE_MIN_MINUTES = 15
export const FREE_MAX_MINUTES = 480
export const FREE_MAX_DAYS = 14
const SLOT_STEP_MINUTES = 15
const MAX_SLOTS = 5
const MAX_SLOTS_PER_DAY = 2
const DEFAULT_DAY: DayHours = { start: "09:00", end: "17:00" }
const WORKWEEK: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri"]

/** Milliseconds since the epoch, the end left out */
export type Interval = { start: number; end: number }
/**
 * `busy: null` means the calendar isn't shared with the asker. Out of office counts either way,
 * and so do work breaks, read daily in the user's own zone.
 */
export type FreePerson = {
  id: string
  busy: Interval[] | null
  ooo?: Interval[]
  hours: WorkingHours | null
  breaks?: DayHours[] | null
  timeZone: string | null
}

type BusyEvent = { starts_at: string | null; ends_at: string | null; all_day: boolean; ooo?: boolean; event_type?: string }

const MINUTE = 60_000

export const zoneOr = (zone: string | null | undefined, fallback: string) => (zone && isValidTimeZone(zone) ? zone : fallback)
export const hasHours = (hours: WorkingHours | null | undefined): hours is WorkingHours => !!hours && Object.keys(hours).length > 0

/** Timed events and all-day out of office, the last read as dates in the zone. Other all-day events don't count */
export function busyOf(events: BusyEvent[], timeZone: string): Interval[] {
  const zone = zoneOr(timeZone, "UTC")
  const out: Interval[] = []
  for (const event of events) {
    const start = event.starts_at ? Date.parse(event.starts_at) : NaN
    const end = event.ends_at ? Date.parse(event.ends_at) : NaN
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    if (!event.all_day) out.push({ start, end })
    else if (event.ooo || event.event_type === "ooo") out.push({ start: fromWallClock(start, zone), end: fromWallClock(end, zone) })
  }
  return out
}

/** One window per wall day around the range in the zone, for the days `pick` gives hours */
function windowsOf(zone: string, from: number, to: number, pick: DayPicker): Interval[] {
  const first = Math.floor(wallClock(from, zone) / DAY_MS) * DAY_MS - DAY_MS
  const last = Math.floor(wallClock(to, zone) / DAY_MS) * DAY_MS + DAY_MS
  const out: Interval[] = []
  for (let midnight = first; midnight <= last; midnight += DAY_MS) {
    const hours = pick(weekdayOf(midnight))
    if (!hours) continue
    out.push({
      start: fromWallClock(midnight + minutesOf(hours.start) * MINUTE, zone),
      end: fromWallClock(midnight + minutesOf(hours.end) * MINUTE, zone),
    })
  }
  return out
}

const within = (slot: Interval, windows: Interval[]) => windows.find((window) => window.start <= slot.start && slot.end <= window.end)
const overlaps = (slot: Interval, list: Interval[]) => list.some((busy) => busy.start < slot.end && slot.start < busy.end)

type Prepared = { windows: Interval[]; blocked: Interval[] }

function prepare(person: FreePerson, askerZone: string, days: Interval[], from: number, to: number): Prepared {
  const zone = zoneOr(person.timeZone, askerZone)
  const hours = person.hours
  const windows = hasHours(hours) ? windowsOf(zone, from, to, (weekday) => hours[weekday]) : days
  const breaks = (person.breaks ?? []).flatMap((part) => windowsOf(zone, from, to, () => part))
  return { windows, blocked: [...(person.busy ?? []), ...(person.ooo ?? []), ...breaks] }
}

type DayPicker = (weekday: Weekday) => DayHours | null | undefined

export const LATEST_AFTER_EARLIEST = "The latest time of day must come after the earliest"

/**
 * The asker's day: their own working hours when set, else 09:00 to 17:00 on weekdays. Both bounds given
 * replace its times, a single bound clips them. Null when a bound leaves no day at all.
 */
export function askerDay(hours: WorkingHours | null, earliest?: string, latest?: string): DayPicker | null {
  const base: DayPicker = (weekday) => (hasHours(hours) ? hours[weekday] : WORKWEEK.includes(weekday) ? DEFAULT_DAY : null)
  if (earliest && latest) return (weekday) => (base(weekday) ? { start: earliest, end: latest } : null)
  const pick: DayPicker = (weekday) => {
    const day = base(weekday)
    if (!day) return null
    const start = earliest && earliest > day.start ? earliest : day.start
    const end = latest && latest < day.end ? latest : day.end
    return end > start ? { start, end } : null
  }
  return WEEKDAYS.some((weekday) => pick(weekday)) ? pick : null
}

const DEFAULT_WORKING_DAYS = 5

/**
 * The window to search, from now through the asker's next 5 working days unless given, counted from tomorrow
 * once today's day is over. A start in the past moves to now. Refuses a window that ends before it starts,
 * has passed, or is longer than 14 days, in words the AI can pass on.
 */
export function freeWindow(
  given: { from?: number; to?: number },
  now: number,
  askerZone: string,
  day: DayPicker,
): Interval | { error: string } {
  const zone = zoneOr(askerZone, "UTC")
  if (given.from !== undefined && given.to !== undefined && given.to <= given.from) {
    return { error: "The end of the window must come after its start" }
  }
  const from = Math.max(given.from ?? now, now)
  let to = given.to
  if (to === undefined) {
    const wall = wallClock(from, zone)
    let midnight = Math.floor(wall / DAY_MS) * DAY_MS
    const today = day(weekdayOf(midnight))
    if (today && wall - midnight >= minutesOf(today.end) * MINUTE) midnight += DAY_MS
    for (let counted = 0, tries = 0; counted < DEFAULT_WORKING_DAYS && tries < FREE_MAX_DAYS; tries++, midnight += DAY_MS) {
      if (day(weekdayOf(midnight))) counted++
    }
    to = Math.min(fromWallClock(midnight, zone), from + FREE_MAX_DAYS * DAY_MS)
  }
  if (to <= from) return { error: "That window is in the past. Pick times from now on" }
  if (to - from > FREE_MAX_DAYS * DAY_MS) return { error: `Look at most ${FREE_MAX_DAYS} days ahead at a time` }
  return { start: from, end: to }
}

/**
 * Up to 5 times when everyone is free and inside their working hours, earliest first, at most 2 a day
 * in the asker's zone, starting on the quarter hour and never in the past. A day's slots never overlap.
 * `day` bounds every slot in the asker's zone, and is the only limit for a user without working hours.
 */
export function findSlots(input: {
  people: FreePerson[]
  askerZone: string
  day: DayPicker
  from: number
  to: number
  minutes: number
  now: number
}): Interval[] {
  const { people, day, from, to, minutes, now } = input
  const zone = zoneOr(input.askerZone, "UTC")
  const days = windowsOf(zone, from, to, day)
  const prepared = people.map((person) => prepare(person, zone, days, from, to))
  const step = SLOT_STEP_MINUTES * MINUTE
  const length = minutes * MINUTE
  const perDay = new Map<number, number>()
  const slots: Interval[] = []
  let lastEnd = -Infinity
  for (let start = Math.ceil(Math.max(from, now) / step) * step; start + length <= to && slots.length < MAX_SLOTS; start += step) {
    if (start < lastEnd) continue
    const slot = { start, end: start + length }
    const today = within(slot, days)
    if (!today || (perDay.get(today.start) ?? 0) >= MAX_SLOTS_PER_DAY) continue
    if (!prepared.every((person) => within(slot, person.windows) && !overlaps(slot, person.blocked))) continue
    slots.push(slot)
    perDay.set(today.start, (perDay.get(today.start) ?? 0) + 1)
    lastEnd = slot.end
  }
  return slots
}
