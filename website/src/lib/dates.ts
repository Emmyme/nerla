type DueTone = "overdue" | "today" | "soon" | "later"
type DateValue = Date | string | null | undefined
export type CalendarView = "day" | "week" | "month" | "schedule"

const DAY_LOCALE = "en-GB"

const weekdayShort = new Intl.DateTimeFormat(DAY_LOCALE, { weekday: "short" })
const weekdayLong = new Intl.DateTimeFormat(DAY_LOCALE, { weekday: "long" })
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const dayTitle = new Intl.DateTimeFormat(DAY_LOCALE, { weekday: "long", day: "numeric", month: "long" })
const monthTitle = new Intl.DateTimeFormat(DAY_LOCALE, { month: "long" })
const monthYearTitle = new Intl.DateTimeFormat(DAY_LOCALE, { month: "long", year: "numeric" })
const fullDayTitle = new Intl.DateTimeFormat(DAY_LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
const LONG_MONTHS = Array.from({ length: 12 }, (_, month) => monthTitle.format(new Date(2026, month, 1)))
const timeFormats = new Map<string, Intl.DateTimeFormat>()

const INSTANT = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})/

export function parseServerDate(value: string | null | undefined): Date | null {
  const match = value ? INSTANT.exec(value.trim()) : null
  if (!match) return null
  const [, day, time = "00:00:00", fraction = "", zone = "Z"] = match
  const seconds = time.length === 5 ? `${time}:00` : time
  const offset = zone.toUpperCase() === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(3).replace(":", "") || "00"}`
  const date = new Date(`${day}T${seconds}${fraction.slice(0, 4)}${offset}`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function parseDueDate(value: DateValue): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate())
  }
  const match = value ? CALENDAR_DAY.exec(value.trim()) : null
  if (!match) return null
  const [year, month, day] = match.slice(1).map(Number)
  const date = new Date(year, month - 1, day)
  return date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

export function toDueDateValue(value: DateValue): string | null {
  const date = parseDueDate(value)
  if (!date) return null
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function toDate(value: DateValue): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  return parseServerDate(value)
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

// Moves by whole months and keeps the day of the month where the target month has it
export function addMonths(date: Date, months: number): Date {
  const first = new Date(date.getFullYear(), date.getMonth() + months, 1)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), last))
}

export function startOfWeek(date: Date): Date {
  return addDays(startOfDay(date), -((date.getDay() + 6) % 7))
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

// ISO 8601: the week that holds the year's first Thursday is week 1
export function weekNumber(date: Date): number {
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate() + 3 - ((date.getDay() + 6) % 7)))
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1)
  return Math.ceil(((thursday.getTime() - yearStart) / 86400000 + 1) / 7)
}

/** "YYYY-MM-DD" of the local calendar day */
export function dayKey(date: Date): string {
  return toDueDateValue(date) ?? ""
}

/** Real minutes in the local day, 1380 and 1500 on daylight saving days */
export function dayLength(day: Date): number {
  return Math.round((addDays(day, 1).getTime() - startOfDay(day).getTime()) / 60000)
}

/** Real minutes since local midnight, so 09:00 on the 25-hour October day is 600 */
export function minutesOfDay(date: Date): number {
  return (date.getTime() - startOfDay(date).getTime()) / 60000
}

/** The instant `minutes` real minutes after the local midnight of `day` */
export function toInstant(day: Date, minutes: number): Date {
  return new Date(startOfDay(day).getTime() + minutes * 60000)
}

/**
 * The local days an event covers, last day included. All-day events are UTC dates with an exclusive
 * end, so they cover the same dates in every zone. A timed event that ends at midnight stays on its day.
 */
export function allDayRange(event: {
  starts_at: string | null
  ends_at: string | null
  all_day: boolean
}): { first: Date; last: Date } | null {
  if (event.all_day) {
    const first = parseDueDate(event.starts_at)
    if (!first) return null
    const end = parseDueDate(event.ends_at)
    const last = end ? addDays(end, -1) : first
    return { first, last: last < first ? first : last }
  }
  const start = parseServerDate(event.starts_at)
  if (!start) return null
  const end = parseServerDate(event.ends_at)
  const first = startOfDay(start)
  const last = end && end > start ? startOfDay(new Date(end.getTime() - 1)) : first
  return { first, last }
}

/** Whole calendar days from `from` to `date` by local date, so DST never shifts the count */
export function dayDiff(date: Date, from: Date): number {
  const a = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const b = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  return Math.round((a - b) / 86400000)
}

function defaultLocale(): string | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.language
}

function timeFormat(locale: string | undefined): Intl.DateTimeFormat {
  const cacheKey = locale ?? ""
  let formatter = timeFormats.get(cacheKey)
  if (!formatter) {
    // The 24 hour clock everywhere, whatever the browser's locale
    formatter = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    timeFormats.set(cacheKey, formatter)
  }
  return formatter
}

export function formatShortDate(value: DateValue, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return ""
  const text = `${date.getDate()} ${MONTHS[date.getMonth()]}`
  return date.getFullYear() === now.getFullYear() ? text : `${text} ${date.getFullYear()}`
}

export function formatRelative(value: DateValue, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return ""
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`
  const days = dayDiff(now, date)
  if (days <= 1) return "yesterday"
  if (days < 7) return `${days} days ago`
  return formatShortDate(date, now)
}

// The compact form for tight columns: now, 5m, 3h, 2d, then the short date
export function formatRelativeShort(value: DateValue, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return ""
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  const days = dayDiff(now, date)
  if (days < 7) return `${Math.max(days, 1)}d`
  return formatShortDate(date, now)
}

/** A day heading in a conversation: "Today", "Yesterday", "Wed 22 Oct", then "22 Oct 2025" for other years */
export function formatDayLabel(value: DateValue, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return ""
  const diff = dayDiff(date, now)
  if (diff === 0) return "Today"
  if (diff === -1) return "Yesterday"
  if (date.getFullYear() !== now.getFullYear()) return formatShortDate(date, now)
  return `${weekdayShort.format(date)} ${formatShortDate(date, now)}`
}

export function formatDue(value: DateValue, now: Date = new Date()): { text: string; tone: DueTone } | null {
  const due = parseDueDate(value)
  if (!due) return null
  const diff = dayDiff(due, now)
  if (diff < 0) return { text: diff === -1 ? "1 day late" : `${-diff} days late`, tone: "overdue" }
  if (diff === 0) return { text: "Today", tone: "today" }
  if (diff === 1) return { text: "Tomorrow", tone: "soon" }
  if (diff <= 6) return { text: weekdayShort.format(due), tone: "soon" }
  return { text: formatShortDate(due, now), tone: "later" }
}

export function formatDayTitle(value: DateValue): string {
  const date = toDate(value)
  return date ? dayTitle.format(date).replace(",", "") : ""
}

function dayMonth(date: Date): string {
  return `${date.getDate()} ${LONG_MONTHS[date.getMonth()]}`
}

/** "19 to 25 October 2026", "28 September to 4 October 2026", "28 December 2026 to 3 January 2027" */
export function formatDaySpan(first: Date, last: Date): string {
  if (sameDay(first, last)) return `${dayMonth(first)} ${first.getFullYear()}`
  if (first.getFullYear() !== last.getFullYear())
    return `${dayMonth(first)} ${first.getFullYear()} to ${dayMonth(last)} ${last.getFullYear()}`
  const from = first.getMonth() === last.getMonth() ? String(first.getDate()) : dayMonth(first)
  return `${from} to ${dayMonth(last)} ${last.getFullYear()}`
}

export function formatRangeTitle(view: CalendarView, date: Date): string {
  if (view === "day") return fullDayTitle.format(date).replace(",", "")
  if (view === "week") {
    const first = startOfWeek(date)
    return formatDaySpan(first, addDays(first, 6))
  }
  return monthYearTitle.format(date)
}

export function formatMonthTitle(value: DateValue, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return ""
  return (date.getFullYear() === now.getFullYear() ? monthTitle : monthYearTitle).format(date)
}

/** "Oct", or "Jan 2027" in another year */
export function formatShortMonthTitle(value: DateValue, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return ""
  const month = MONTHS[date.getMonth()]
  return date.getFullYear() === now.getFullYear() ? month : `${month} ${date.getFullYear()}`
}

export function formatWeekdayLong(value: DateValue): string {
  const date = toDate(value)
  return date ? weekdayLong.format(date) : ""
}

/** "23 October" */
export function formatDayMonth(value: DateValue): string {
  const date = toDate(value)
  return date ? dayMonth(date) : ""
}

/** "30 November 2026" */
export function formatLongDate(value: DateValue): string {
  const date = toDate(value)
  return date ? `${dayMonth(date)} ${date.getFullYear()}` : ""
}

export function formatWeekdayShort(value: DateValue): string {
  const date = toDate(value)
  return date ? weekdayShort.format(date) : ""
}

export function formatStartsIn(start: DateValue, now: Date = new Date()): string {
  const date = toDate(start)
  if (!date) return ""
  const minutes = Math.ceil((date.getTime() - now.getTime()) / 60000)
  if (minutes <= 0) return "Now"
  if (minutes < 60) return `In ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `In ${hours} h` : `In ${hours} h ${rest} min`
}

/** A running call clock, such as 4:05 or 1:02:03 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`
}

/** How long a call lasted, in the words of formatStartsIn */
export function formatCallLength(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000)
  if (minutes < 1) return "Less than a minute"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

export function formatTime(value: DateValue, locale: string | undefined = defaultLocale()): string {
  const date = toDate(value)
  return date
    ? timeFormat(locale)
        .format(date)
        .replace(/[\u202F\u00A0]/g, " ")
    : ""
}

export function formatTimeRange(start: DateValue, end: DateValue, locale?: string): string {
  const from = formatTime(start, locale)
  const to = formatTime(end, locale)
  return from && to ? `${from} to ${to}` : from || to
}

const zoneFormats = new Map<string, Intl.DateTimeFormat | null>()

function zoneFormat(timeZone: string): Intl.DateTimeFormat | null {
  if (!zoneFormats.has(timeZone)) {
    let format: Intl.DateTimeFormat | null = null
    try {
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
    } catch {
      format = null
    }
    zoneFormats.set(timeZone, format)
  }
  return zoneFormats.get(timeZone) ?? null
}

function zoneFields(value: Date, timeZone: string): number[] | null {
  const format = zoneFormat(timeZone)
  if (!format) return null
  const parts: Record<string, number> = {}
  for (const part of format.formatToParts(value)) if (part.type !== "literal") parts[part.type] = Number(part.value)
  return [parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second]
}

/**
 * The wall time of an instant in another zone, as a local date with the same fields, so the formatters
 * above show it. Without a zone, or with an unknown one, the instant stays as it is.
 */
export function wallTimeIn(value: Date, timeZone: string | null | undefined): Date {
  const fields = timeZone ? zoneFields(value, timeZone) : null
  if (!fields) return value
  const [year, month, day, hour, minute, second] = fields
  return new Date(year, month, day, hour, minute, second)
}

/** Minutes the zone is ahead of UTC at the instant */
export function zoneOffsetMinutes(value: Date, timeZone: string): number | null {
  const fields = zoneFields(value, timeZone)
  if (!fields) return null
  const [year, month, day, hour, minute, second] = fields
  return Math.round((Date.UTC(year, month, day, hour, minute, second) - Math.floor(value.getTime() / 1000) * 1000) / 60000)
}

/** "2 h ahead", "1 h 30 min behind", or "" when both zones show the same time */
export function formatZoneDifference(value: Date, theirZone: string, myZone: string): string {
  const theirs = zoneOffsetMinutes(value, theirZone)
  const mine = zoneOffsetMinutes(value, myZone)
  if (theirs === null || mine === null || theirs === mine) return ""
  const diff = Math.abs(theirs - mine)
  const hours = Math.floor(diff / 60)
  const minutes = diff % 60
  const size = [hours ? `${hours} h` : "", minutes ? `${minutes} min` : ""].filter(Boolean).join(" ")
  return `${size} ${theirs > mine ? "ahead" : "behind"}`
}

/** The zone this device is set to */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}
