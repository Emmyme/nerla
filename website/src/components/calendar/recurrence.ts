import { formatDayMonth, formatWeekdayLong } from "@/lib/dates"

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"
export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
type Preset = "none" | "daily" | "weekly" | "monthly" | "yearly" | "weekdays" | "custom"
export type RecurrenceEnd = { kind: "never" } | { kind: "on"; date: Date } | { kind: "after"; count: number }
export type CustomRecurrence = { freq: Frequency; interval: number; weekdays: Weekday[]; end: RecurrenceEnd }

export const WEEKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
export const PRESETS: readonly Exclude<Preset, "custom">[] = ["none", "daily", "weekly", "monthly", "yearly", "weekdays"]
const FREQUENCIES: readonly Frequency[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]
const ORDINAL: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" }
// The server takes up to three digits for INTERVAL and COUNT
const MAX_NUMBER = 999

const pad = (n: number) => String(n).padStart(2, "0")
export const clamp = (n: number) => Math.min(MAX_NUMBER, Math.max(1, Math.round(n) || 1))

function weekdayCode(date: Date): Weekday {
  return WEEKDAYS[(date.getDay() + 6) % 7]
}

/** Which weekday of the month the date is. A fifth weekday does not come every month, so it is the last. */
export function monthlyPosition(date: Date): number {
  const nth = Math.ceil(date.getDate() / 7)
  return nth === 5 ? -1 : nth
}

const monthlyDay = (start: Date) => `${monthlyPosition(start)}${weekdayCode(start)}`

export function presetRule(preset: Exclude<Preset, "custom">, start: Date): string | null {
  switch (preset) {
    case "none":
      return null
    case "daily":
      return "FREQ=DAILY"
    case "weekly":
      return `FREQ=WEEKLY;BYDAY=${weekdayCode(start)}`
    case "monthly":
      return `FREQ=MONTHLY;BYDAY=${monthlyDay(start)}`
    case "yearly":
      return "FREQ=YEARLY"
    case "weekdays":
      return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
  }
}

export function presetLabel(preset: Preset, start: Date): string {
  switch (preset) {
    case "none":
      return "Does not repeat"
    case "daily":
      return "Daily"
    case "weekly":
      return `Weekly on ${formatWeekdayLong(start)}`
    case "monthly":
      return `Monthly on the ${ORDINAL[monthlyPosition(start)]} ${formatWeekdayLong(start)}`
    case "yearly":
      return `Annually on ${formatDayMonth(start)}`
    case "weekdays":
      return "Every weekday (Mon to Fri)"
    case "custom":
      return "Custom"
  }
}

/** Weekly rules list their days, monthly rules repeat on the start's weekday of the month */
export function customRule(custom: CustomRecurrence, start: Date): string {
  const parts = [`FREQ=${custom.freq}`]
  const interval = clamp(custom.interval)
  if (interval > 1) parts.push(`INTERVAL=${interval}`)
  if (custom.freq === "WEEKLY") {
    const days = custom.weekdays.length ? custom.weekdays : [weekdayCode(start)]
    parts.push(`BYDAY=${WEEKDAYS.filter((day) => days.includes(day)).join(",")}`)
  }
  if (custom.freq === "MONTHLY") parts.push(`BYDAY=${monthlyDay(start)}`)
  const { end } = custom
  if (end.kind === "on") parts.push(`UNTIL=${end.date.getFullYear()}${pad(end.date.getMonth() + 1)}${pad(end.date.getDate())}`)
  if (end.kind === "after") parts.push(`COUNT=${clamp(end.count)}`)
  return parts.join(";")
}

function partsOf(rule: string): Map<string, string> {
  return new Map(
    rule
      .replace(/^RRULE:/i, "")
      .split(";")
      .map((part) => part.split("=") as [string, string]),
  )
}

function untilDay(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  if (match[7]) {
    const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
    return new Date(instant.getFullYear(), instant.getMonth(), instant.getDate())
  }
  return new Date(year, month - 1, day)
}

/** The custom form for a rule, or a weekly rule on the start's weekday when there is none */
export function customFrom(rule: string | null, start: Date): CustomRecurrence {
  const fallback: CustomRecurrence = { freq: "WEEKLY", interval: 1, weekdays: [weekdayCode(start)], end: { kind: "never" } }
  if (!rule) return fallback
  const parts = partsOf(rule)
  const freq = parts.get("FREQ") as Frequency
  if (!FREQUENCIES.includes(freq)) return fallback
  const byDay = (parts.get("BYDAY") ?? "").split(",").filter((day): day is Weekday => WEEKDAYS.includes(day as Weekday))
  const untilValue = parts.get("UNTIL")
  const until = untilValue ? untilDay(untilValue) : null
  const count = Number(parts.get("COUNT"))
  return {
    freq,
    interval: clamp(Number(parts.get("INTERVAL") ?? 1)),
    weekdays: freq === "WEEKLY" && byDay.length ? byDay : [weekdayCode(start)],
    end: until ? { kind: "on", date: until } : count ? { kind: "after", count } : { kind: "never" },
  }
}

export function presetOf(rule: string | null, start: Date): Preset {
  if (!rule) return "none"
  return PRESETS.find((preset) => presetRule(preset, start) === rule) ?? "custom"
}

/**
 * When the start moves, a rule built from it moves too, so "Weekly on Friday" becomes "Weekly on
 * Monday". Rules with their own choice of days, or ones this editor did not build, stay as they are.
 */
export function followStart(rule: string | null, from: Date, to: Date): string | null {
  if (!rule) return rule
  const custom = customFrom(rule, from)
  if (customRule(custom, from) !== rule) return rule
  if (custom.freq === "WEEKLY" && custom.weekdays.length === 1 && custom.weekdays[0] === weekdayCode(from))
    custom.weekdays = [weekdayCode(to)]
  return customRule(custom, to)
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
