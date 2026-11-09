/**
 * Event times are stored as UTC wall time in `timestamp without time zone` columns.
 * Reads append the zone, writes accept only instants that carry one.
 */

export class InstantError extends Error {
  readonly statusCode = 400
}

export const DAY_MS = 86_400_000
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/
const STORED = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

function fieldsToMs(match: RegExpExecArray): number | null {
  const offset = offsetMs(match[8])
  if (offset === null) return null
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number)
  const second = match[6] ? Number(match[6]) : 0
  const ms = match[7] ? Math.floor(Number(match[7]) * 1000) : 0
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const check = new Date(wall)
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null
  }
  return wall - offset
}

function offsetMs(zone: string | undefined): number | null {
  if (!zone || zone === "Z") return 0
  const sign = zone[0] === "-" ? -1 : 1
  const digits = zone.slice(1).replace(":", "")
  const hours = Number(digits.slice(0, 2))
  const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0
  if (hours > 14 || minutes > 59) return null
  return sign * (hours * 60 + minutes) * 60_000
}

/** Milliseconds for an ISO 8601 time with Z or an offset, or null. */
export function parseInstant(iso: string): number | null {
  const match = ISO_INSTANT.exec(iso)
  return match ? fieldsToMs(match) : null
}

/** Milliseconds for a stored value (zone-less means UTC) or an ISO instant, or null. */
export function storedMs(value: string | null | undefined): number | null {
  if (!value) return null
  const match = STORED.exec(value)
  return match ? fieldsToMs(match) : null
}

export function readInstant(dbValue: string | null | undefined): string | null {
  const ms = storedMs(dbValue)
  return ms === null ? null : new Date(ms).toISOString()
}

export function msToStored(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "")
}

export function writeInstant(iso: string): string {
  const ms = parseInstant(iso)
  if (ms === null) throw new InstantError(`Expected an ISO time with Z or an offset, got "${iso}"`)
  return msToStored(ms)
}

function parseDate(date: string): number {
  const match = DATE_ONLY.exec(date)
  const ms = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new InstantError(`Expected a date as YYYY-MM-DD, got "${date}"`)
  }
  return ms
}

/** All-day events run from 00:00 UTC of the first day to 00:00 UTC of the day after the last. */
export function allDayBounds(startDate: string, endDateInclusive: string): { starts_at: string; ends_at: string } {
  const start = parseDate(startDate)
  const end = parseDate(endDateInclusive)
  if (end < start) throw new InstantError("The last day comes before the first day")
  return {
    starts_at: new Date(start).toISOString(),
    ends_at: new Date(end + DAY_MS).toISOString(),
  }
}

export function isUtcMidnight(ms: number): boolean {
  return ms % DAY_MS === 0
}

const EAST_MS = 14 * 3_600_000
const WEST_MS = 12 * 3_600_000

/**
 * Whether an event belongs in a window of instants. A timed event overlaps it. An all-day event is
 * a set of dates, kept when a viewer in some zone from UTC-12 to UTC+14 sees one of them in the window.
 */
export function inWindow(startMs: number, endMs: number, allDay: boolean, window: { from: number; to: number }): boolean {
  if (allDay) return startMs < window.to + EAST_MS && endMs > window.from - WEST_MS
  if (endMs <= startMs) return startMs >= window.from && startMs < window.to
  return startMs < window.to && endMs > window.from
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
    formatters.set(timeZone, format)
  }
  return format
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(timeZone)) return false
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

/** The wall time of an instant in a zone, as milliseconds of a UTC date with the same fields. */
export function wallClock(instantMs: number, timeZone: string): number {
  const parts: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value)
  }
  const subSecond = ((instantMs % 1000) + 1000) % 1000
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, subSecond)
}

/** A stored or ISO time as the wall clock minute in a zone, such as 2026-11-02T09:30 */
export function localMinute(value: string, timeZone: string): string {
  const ms = storedMs(value)
  if (ms === null) return value
  return new Date(wallClock(ms, isValidTimeZone(timeZone) ? timeZone : "UTC")).toISOString().slice(0, 16)
}

/**
 * The instant showing a wall time in a zone. A time in the spring gap moves forward by the gap,
 * a time in the repeated autumn hour takes the first of the two.
 */
export function fromWallClock(wallMs: number, timeZone: string): number {
  const offsetAt = (ms: number) => wallClock(ms, timeZone) - ms
  const before = offsetAt(wallMs - DAY_MS)
  let best: number | null = null
  for (const offset of new Set([before, offsetAt(wallMs), offsetAt(wallMs + DAY_MS)])) {
    const instant = wallMs - offset
    if (wallClock(instant, timeZone) === wallMs && (best === null || instant < best)) best = instant
  }
  return best ?? wallMs - before
}
