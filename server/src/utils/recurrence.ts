import { RRule, type Options } from "rrule"
import { DAY_MS, fromWallClock, isValidTimeZone, readInstant, storedMs, wallClock } from "./eventTime"

/**
 * Series expand in their own zone. Their start is turned into a zone-less wall time, rrule
 * steps through wall times only (no TZID), and each result is mapped back to an instant.
 * All-day series are dates, so they step in UTC.
 */

const MAX_OCCURRENCES = 500
const SECOND_MS = 1000
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
const BASE_PARTS = ["FREQ", "INTERVAL", "COUNT", "UNTIL", "WKST"]
const PARTS_BY_FREQ: Record<string, string[]> = {
  DAILY: BASE_PARTS,
  WEEKLY: [...BASE_PARTS, "BYDAY"],
  MONTHLY: [...BASE_PARTS, "BYDAY", "BYMONTHDAY"],
  YEARLY: BASE_PARTS,
}

export type SeriesRow = {
  id: string
  startsAt: string
  endsAt: string
  allDay: boolean
  recurrenceRule: string | null
  recurrenceTz: string | null
}

export type OverrideRow = {
  id: string
  startsAt: string
  endsAt: string
  seriesId: string | null
  originalStart: string | null
  cancelled: boolean
}

export type OccurrenceFields = {
  occurrence_id: string
  series_id: string | null
  original_start: string | null
}

type Occurrence<T> = T & OccurrenceFields

type TimeWindow = { from: string; to: string }

type RuleParts = Map<string, string>

function untilWall(value: string, timeZone: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value)
  if (!match) return null
  const [year, month, day] = match.slice(1, 4).map(Number)
  const [hour, minute, second] = match[4] ? match.slice(4, 7).map(Number) : [0, 0, 0]
  const fields = Date.UTC(year, month - 1, day, hour, minute, second)
  const check = new Date(fields)
  const same =
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute &&
    check.getUTCSeconds() === second
  if (!same) return null
  if (!match[4]) return fields + DAY_MS - SECOND_MS
  return match[7] ? wallClock(fields, timeZone) : fields
}

function validWeekday(value: string, freq: string): boolean {
  const match = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(value)
  if (!match) return false
  if (!match[1]) return true
  const nth = Math.abs(Number(match[1]))
  return freq === "MONTHLY" && nth >= 1 && nth <= 5
}

function validPart(key: string, value: string, freq: string): boolean {
  switch (key) {
    case "FREQ":
      return true
    case "INTERVAL":
    case "COUNT":
      return /^[1-9]\d{0,2}$/.test(value)
    case "UNTIL":
      return untilWall(value, "UTC") !== null
    case "WKST":
      return WEEKDAYS.includes(value)
    case "BYDAY":
      return value.split(",").every((day) => validWeekday(day, freq))
    case "BYMONTHDAY":
      return value.split(",").every((day) => /^-?\d{1,2}$/.test(day) && Math.abs(Number(day)) >= 1 && Math.abs(Number(day)) <= 31)
    default:
      return false
  }
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/**
 * A monthly rule visits the same calendar month every year when INTERVAL is a multiple of 12,
 * so a day past the 28th or a fifth weekday may never come. When the visited months come back
 * every 28 years, their weekdays repeat too, so a fifth weekday may never come either.
 */
function alwaysMatches(parts: RuleParts): boolean {
  if (parts.get("FREQ") !== "MONTHLY") return true
  const interval = Number(parts.get("INTERVAL") ?? 1)
  const sameMonth = interval % 12 === 0
  const sameWeekdays = (interval / gcd(interval, 12)) % 28 === 0
  const days = (parts.get("BYMONTHDAY")?.split(",") ?? []).map((day) => Math.abs(Number(day)))
  const nths = (parts.get("BYDAY")?.split(",") ?? []).map((day) => Math.abs(parseInt(day, 10)) || 0)
  if (sameMonth && days.some((day) => day > 28)) return false
  if ((sameMonth || sameWeekdays) && nths.some((nth) => nth > 4)) return false
  return true
}

/** rrule's own `toString()` starts with this prefix. Rules are stored without it. */
export function normalizeRecurrenceRule(rule: string): string {
  return rule.replace(/^RRULE:/i, "")
}

/**
 * The editor's rule shapes only (Google's daily, weekly, monthly, yearly and custom). Rules that
 * step below a day, or whose filters can skip every date, are refused, because rrule would then
 * walk to the year 9999.
 */
function ruleParts(rule: string): RuleParts | null {
  const body = normalizeRecurrenceRule(rule)
  if (body.length === 0 || body.length > 500) return null
  const parts: RuleParts = new Map()
  for (const piece of body.split(";")) {
    const match = /^([A-Z]+)=([A-Z0-9,+-]+)$/.exec(piece)
    if (!match || parts.has(match[1])) return null
    parts.set(match[1], match[2])
  }
  const allowed = PARTS_BY_FREQ[parts.get("FREQ") ?? ""]
  if (!allowed) return null
  if (parts.has("COUNT") && parts.has("UNTIL")) return null
  if (parts.has("BYDAY") && parts.has("BYMONTHDAY")) return null
  for (const [key, value] of parts) {
    if (!allowed.includes(key) || !validPart(key, value, parts.get("FREQ")!)) return null
  }
  return alwaysMatches(parts) ? parts : null
}

const UNITS: Record<string, string> = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }
const DAY_NAMES: Record<string, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" }
const NTH: Record<string, string> = { "1": "first", "2": "second", "3": "third", "4": "fourth", "-1": "last" }
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const listed = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`)

/** A rule in plain words, such as "every 2 weeks on Mon and Wed, 6 times". Null for a rule the calendar refuses */
export function describeRecurrence(rule: string): string | null {
  const parts = ruleParts(rule)
  if (!parts) return null
  const unit = UNITS[parts.get("FREQ")!]
  const interval = Number(parts.get("INTERVAL") ?? 1)
  let text = interval > 1 ? `every ${interval} ${unit}s` : `every ${unit}`
  const days = parts.get("BYDAY")?.split(",") ?? []
  if (days.length) {
    text += ` on ${listed(
      days.map((day) => {
        const match = /^([+-]?\d+)?([A-Z]{2})$/.exec(day)
        const name = DAY_NAMES[match?.[2] ?? ""] ?? day
        const nth = match?.[1] ? NTH[String(Number(match[1]))] : null
        return nth ? `the ${nth} ${name}` : name
      }),
    )}`
  }
  const monthDays = parts.get("BYMONTHDAY")?.split(",") ?? []
  if (monthDays.length) text += ` on day ${listed(monthDays)}`
  const count = parts.get("COUNT")
  if (count) text += `, ${count} times`
  const until = /^(\d{4})(\d{2})(\d{2})/.exec(parts.get("UNTIL") ?? "")
  if (until) text += `, until ${Number(until[3])} ${MONTHS[Number(until[2]) - 1]} ${until[1]}`
  return text
}

function joinParts(parts: RuleParts): string {
  return [...parts].map(([key, value]) => `${key}=${value}`).join(";")
}

function buildRule(parts: RuleParts, dtstartWall: number, timeZone: string, extra: Partial<Options> = {}): RRule {
  const withoutUntil = new Map(parts)
  withoutUntil.delete("UNTIL")
  const options: Partial<Options> = {
    ...RRule.parseString(joinParts(withoutUntil)),
    ...extra,
    dtstart: new Date(dtstartWall),
    tzid: null,
  }
  const until = parts.get("UNTIL")
  if (until) options.until = new Date(untilWall(until, timeZone)!)
  return new RRule(options)
}

export function isValidRecurrenceRule(rule: string): boolean {
  const parts = ruleParts(rule)
  if (!parts) return false
  try {
    buildRule(parts, Date.UTC(2026, 0, 1, 9), "UTC")
    return true
  } catch {
    return false
  }
}

export type SeriesTiming = Pick<SeriesRow, "startsAt" | "allDay" | "recurrenceTz">

function prepare(rule: string, series: SeriesTiming) {
  const parts = ruleParts(rule)
  const startMs = storedMs(series.startsAt)
  if (!parts || startMs === null) return null
  const timeZone = seriesTimeZone(series)
  const startWall = Math.floor(wallClock(startMs, timeZone) / SECOND_MS) * SECOND_MS
  try {
    return { parts, timeZone, startWall, rrule: buildRule(parts, startWall, timeZone) }
  } catch {
    return null
  }
}

type Prepared = NonNullable<ReturnType<typeof prepare>>

/**
 * The rule restarted a whole number of periods later, at least one period before `wall`, so old
 * series do not walk every date since their start. It produces the same dates from the restart
 * on. Monthly and yearly restarts pin the day the start implied. Counted rules keep their start.
 */
function ruleNear(series: Prepared, wall: number): RRule {
  const { parts, startWall, timeZone } = series
  if (parts.has("COUNT")) return series.rrule
  const freq = parts.get("FREQ")
  const interval = Number(parts.get("INTERVAL") ?? 1)

  if (freq === "DAILY" || freq === "WEEKLY") {
    const period = interval * (freq === "DAILY" ? 1 : 7) * DAY_MS
    const periods = Math.floor((wall - startWall) / period) - 1
    return periods > 0 ? buildRule(parts, startWall + periods * period, timeZone) : series.rrule
  }

  const start = new Date(startWall)
  const target = new Date(wall)
  const year = start.getUTCFullYear()
  const month = start.getUTCMonth()
  const timeOfDay = startWall - Date.UTC(year, month, start.getUTCDate())

  if (freq === "MONTHLY") {
    const months = (target.getUTCFullYear() - year) * 12 + target.getUTCMonth() - month
    const periods = Math.floor(months / interval) - 1
    if (periods <= 0) return series.rrule
    const pinned = parts.has("BYDAY") || parts.has("BYMONTHDAY") ? {} : { bymonthday: start.getUTCDate() }
    return buildRule(parts, Date.UTC(year, month + periods * interval, 1) + timeOfDay, timeZone, pinned)
  }

  const periods = Math.floor((target.getUTCFullYear() - year) / interval) - 1
  if (periods <= 0) return series.rrule
  return buildRule(parts, Date.UTC(year + periods * interval, 0, 1) + timeOfDay, timeZone, {
    bymonth: month + 1,
    bymonthday: start.getUTCDate(),
  })
}

const iso = (ms: number) => new Date(ms).toISOString()
const seconds = (ms: number) => Math.floor(ms / SECOND_MS)

/**
 * The rrule date that lands on `instant`, or null when the rule has no occurrence there. A date in
 * the spring gap lands up to a gap later than its wall time, so the search looks back a day.
 */
function producedAt(rule: RRule, timeZone: string, instant: number): Date | null {
  const wall = wallClock(instant, timeZone)
  for (const date of rule.between(new Date(wall - DAY_MS), new Date(wall), true)) {
    if (seconds(fromWallClock(date.getTime(), timeZone)) === seconds(instant)) return date
  }
  return null
}

function overlaps(start: number, end: number, from: number, to: number): boolean {
  if (end <= start) return start >= from && start < to
  return start < to && end > from
}

/** Occurrence ids for a row that is not part of an expansion. */
export function occurrenceFieldsOf(row: {
  id: string
  startsAt: string
  recurrenceRule?: string | null
  seriesId?: string | null
  originalStart?: string | null
}): OccurrenceFields {
  const original = readInstant(row.originalStart)
  if (row.seriesId && original) {
    return { occurrence_id: `${row.seriesId}:${original}`, series_id: row.seriesId, original_start: original }
  }
  const start = readInstant(row.startsAt)
  if (row.recurrenceRule && start) {
    return { occurrence_id: `${row.id}:${start}`, series_id: row.id, original_start: start }
  }
  return { occurrence_id: row.id, series_id: null, original_start: null }
}

/**
 * Occurrences of a series that overlap the window, sorted by start and capped at 500.
 * An override replaces the occurrence it was made from, and a cancelled one removes it.
 * Overrides of times the rule no longer produces are left out.
 */
export function expandSeries<M extends SeriesRow, O extends OverrideRow>(
  master: M,
  overrides: O[],
  window: TimeWindow,
): Occurrence<M | O>[] {
  const from = storedMs(window.from)
  const to = storedMs(window.to)
  const start = storedMs(master.startsAt)
  const end = storedMs(master.endsAt)
  if (from === null || to === null || start === null || end === null) return []
  const duration = Math.max(0, end - start)

  const series = master.recurrenceRule ? prepare(master.recurrenceRule, master) : null
  if (!series) {
    if (!overlaps(start, end, from, to)) return []
    return [{ ...master, startsAt: iso(start), endsAt: iso(end), ...occurrenceFieldsOf({ ...master, recurrenceRule: null }) }]
  }

  const { timeZone } = series
  const own = overrides.filter((o) => o.seriesId === master.id && storedMs(o.originalStart) !== null)
  const replaced = new Set(own.map((o) => seconds(storedMs(o.originalStart)!)))
  const moved = own.flatMap((row) => {
    const s = storedMs(row.startsAt)
    const e = storedMs(row.endsAt)
    if (row.cancelled || s === null || e === null || !overlaps(s, e, from, to)) return []
    return [{ row, s, e, original: storedMs(row.originalStart)! }]
  })

  const occurrence = <T extends M | O>(row: T, original: number, s: number, e: number): Occurrence<T> => {
    const fields: OccurrenceFields = {
      occurrence_id: `${master.id}:${iso(original)}`,
      series_id: master.id,
      original_start: iso(original),
    }
    return Object.assign({}, row, { startsAt: iso(s), endsAt: iso(e) }, fields)
  }

  const fromWall = wallClock(from, timeZone) - duration - DAY_MS
  const toWall = wallClock(to, timeZone) + DAY_MS
  const earliest = Math.min(fromWall, ...moved.map((m) => wallClock(m.original, timeZone) - DAY_MS))
  const near = ruleNear(series, earliest)
  const out: Occurrence<M | O>[] = []

  near.between(new Date(fromWall), new Date(toWall), true, (date) => {
    const original = fromWallClock(date.getTime(), timeZone)
    if (!replaced.has(seconds(original)) && overlaps(original, original + duration, from, to)) {
      out.push(occurrence(master, original, original, original + duration))
    }
    return out.length < MAX_OCCURRENCES
  })

  for (const { row, s, e, original } of moved) {
    if (producedAt(near, timeZone, original)) out.push(occurrence(row, original, s, e))
  }

  return out.sort((a, b) => storedMs(a.startsAt)! - storedMs(b.startsAt)!).slice(0, MAX_OCCURRENCES)
}

/** The zone a series repeats in: UTC for all-day series and for a missing or unknown zone. */
export function seriesTimeZone(series: Pick<SeriesRow, "allDay" | "recurrenceTz">): string {
  return series.allDay ? "UTC" : series.recurrenceTz && isValidTimeZone(series.recurrenceTz) ? series.recurrenceTz : "UTC"
}

/** True when the series has an occurrence starting at `at`. */
export function occursAt(rule: string, at: string, series: SeriesTiming): boolean {
  const prepared = prepare(rule, series)
  const atMs = storedMs(at)
  if (!prepared || atMs === null) return false
  const near = ruleNear(prepared, wallClock(atMs, prepared.timeZone) - DAY_MS)
  return producedAt(near, prepared.timeZone, atMs) !== null
}

/** The start of the first occurrence after `after`, or null when the series has ended. */
export function nextOccurrence(rule: string, after: string, series: SeriesTiming): string | null {
  const prepared = prepare(rule, series)
  const afterMs = storedMs(after)
  if (!prepared || afterMs === null) return null
  const { timeZone } = prepared
  const near = ruleNear(prepared, wallClock(afterMs, timeZone) - DAY_MS)
  let cursor = new Date(wallClock(afterMs, timeZone) - DAY_MS)
  for (let step = 0; step < 8; step++) {
    const date = near.after(cursor, false)
    if (!date) return null
    const instant = fromWallClock(date.getTime(), timeZone)
    if (seconds(instant) > seconds(afterMs)) return iso(instant)
    cursor = date
  }
  return null
}

function formatUntil(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
}

/**
 * A timed UNTIL moves with a series whose wall-clock time moved by `shift`, so its last occurrence
 * stays in. An UNTIL that is a date keeps its day.
 */
export function shiftUntil(rule: string, shift: number, fromZone: string, toZone: string): string {
  const parts = ruleParts(rule)
  const until = parts?.get("UNTIL")
  const timed = until ? /T\d{6}(Z?)$/.exec(until) : null
  if (!parts || !until || !timed || (shift === 0 && fromZone === toZone)) return rule
  const wall = untilWall(until, fromZone)! + shift
  parts.set("UNTIL", timed[1] ? formatUntil(fromWallClock(wall, toZone)) : formatUntil(wall).replace("Z", ""))
  return joinParts(parts)
}

/**
 * "This and following" at an occurrence of the series. The old series ends with UNTIL at its last
 * occurrence before `at` (null when there is none), the new series gets the rest. Throws when the
 * rule has no occurrence at `at`.
 */
export function splitSeries(rule: string, at: string, series: SeriesTiming): { head: string | null; tail: string } {
  const prepared = prepare(rule, series)
  const atMs = storedMs(at)
  if (!prepared || atMs === null) throw new Error("Cannot split an invalid series")
  const { parts, rrule, timeZone, startWall } = prepared
  const near = ruleNear(prepared, wallClock(atMs, timeZone) - DAY_MS)
  const split = producedAt(near, timeZone, atMs)
  if (!split) throw new Error("The series has no occurrence at that time")

  const previous = near.before(split, false) ?? (near === rrule ? null : rrule.before(split, false))
  let head: string | null = null
  if (previous) {
    const headParts = new Map(parts)
    headParts.delete("COUNT")
    headParts.set("UNTIL", formatUntil(fromWallClock(previous.getTime(), timeZone)))
    head = joinParts(headParts)
  }

  const tailParts = new Map(parts)
  const count = parts.get("COUNT")
  if (count) {
    const earlier = rrule.between(new Date(startWall), new Date(split.getTime() - SECOND_MS), true).length
    tailParts.set("COUNT", String(Number(count) - earlier))
  }
  return { head, tail: joinParts(tailParts) }
}
