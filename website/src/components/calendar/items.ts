import type { CalendarEntry } from "@/lib/api/calendar"
import {
  addDays,
  allDayRange,
  formatDayMonth,
  formatLongDate,
  formatShortDate,
  formatTime,
  formatTimeRange,
  formatWeekdayLong,
  parseServerDate,
} from "@/lib/dates"
import { eventTypeLabel } from "@/lib/eventColors"
import type { PersonTone } from "@/lib/personColors"
import { WEEKDAYS } from "./recurrence"

export type TeamPerson = { id: string; name: string; tone: PersonTone }

/** One entry as the views place it: the user's events, or a teammate's overlay with their color */
export type CalendarItem = {
  key: string
  entry: CalendarEntry
  starts_at: string | null
  ends_at: string | null
  all_day: boolean
  person: TeamPerson | null
}

export const NO_TITLE = "(No title)"
export const OOO_TITLE = "Out of office"

type Times = Pick<CalendarItem, "starts_at" | "ends_at" | "all_day">

/** Out of office, also when sharing hides everything else about it */
export const isAway = (entry: CalendarEntry) => (entry.busy ? !!entry.ooo : entry.event_type === "ooo")

/** A teammate's busy time names them, since teammate colors repeat in a big team */
export function itemTitle(item: CalendarItem): string {
  if (item.entry.busy) {
    const label = item.entry.ooo ? OOO_TITLE : "Busy"
    return item.person ? `${label}, ${item.person.name}` : label
  }
  return item.entry.title.trim() || NO_TITLE
}

export function itemTimes(item: Times): { start: Date; end: Date } | null {
  const start = parseServerDate(item.starts_at)
  if (!start) return null
  const end = parseServerDate(item.ends_at)
  return { start, end: end && end > start ? end : start }
}

/** "09:00 to 10:00", "All day", or the dates for events over several days */
export function itemTimeText(item: Times): string {
  if (item.all_day) {
    const range = allDayRange(item)
    if (!range || range.first.getTime() === range.last.getTime()) return "All day"
    return `${formatShortDate(range.first)} to ${formatShortDate(range.last)}, all day`
  }
  const times = itemTimes(item)
  if (!times) return ""
  const range = allDayRange(item)
  if (range && range.first.getTime() !== range.last.getTime()) {
    return `${formatShortDate(times.start)} ${formatTime(times.start)} to ${formatShortDate(times.end)} ${formatTime(times.end)}`
  }
  return formatTimeRange(times.start, times.end)
}

export const JOIN_LEAD_MINUTES = 10

type CallTimes = Times & { video_call: boolean }

/** An all-day call is open through its days */
export function callWindow(event: Times): { start: Date; end: Date } | null {
  if (event.all_day) {
    const range = allDayRange(event)
    return range && { start: range.first, end: addDays(range.last, 1) }
  }
  const start = parseServerDate(event.starts_at)
  const end = parseServerDate(event.ends_at)
  return start && end ? { start, end } : null
}

/** Join opens 10 minutes before the start and stays open until the end, on video events only */
export function joinOpen(event: CallTimes, now: Date): boolean {
  if (!event.video_call) return false
  const span = callWindow(event)
  return !!span && now.getTime() >= span.start.getTime() - JOIN_LEAD_MINUTES * 60_000 && now < span.end
}

/**
 * What the details popover offers. Its creator or a workspace admin edits a saved event, only an admin deletes, and
 * busy time shows no actions at all
 */
export function eventRights(entry: CalendarEntry, userId: string | undefined, orgAdmin: boolean): { edit: boolean; delete: boolean } {
  if (entry.busy) return { edit: false, delete: false }
  return { edit: !entry.id.startsWith("temp-") && (entry.created_by === userId || orgAdmin), delete: orgAdmin }
}

/** The user's answer to an invite on their own calendar: not answered yet, declined, or nothing to show */
export function inviteOf(item: CalendarItem): "pending" | "declined" | null {
  if (item.person || item.entry.busy) return null
  if (item.entry.viewer_response === "pending") return "pending"
  return item.entry.viewer_response === "no" ? "declined" : null
}

const INVITE_WORD = { pending: "Not answered", declined: "Declined" } as const

export function itemLabel(item: CalendarItem): string {
  const { entry, person } = item
  const parts = [itemTitle(item), itemTimeText(item)]
  if (!entry.busy) {
    parts.push(eventTypeLabel(entry.event_type))
    if (entry.location) parts.push(entry.location)
  }
  const invite = inviteOf(item)
  if (invite) parts.push(INVITE_WORD[invite])
  if (person && !entry.busy) parts.push(person.name)
  return parts.filter(Boolean).join(", ")
}

export function hasEnded(item: CalendarItem, now: Date): boolean {
  if (item.all_day) {
    const range = allDayRange(item)
    return !!range && range.last.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  }
  const times = itemTimes(item)
  return !!times && times.end.getTime() <= now.getTime()
}

const ORDER: readonly string[] = WEEKDAYS
const NTH: Record<string, string> = { "1": "first", "2": "second", "3": "third", "4": "fourth", "-1": "last" }

// 5 January 2026 is a Monday, so ORDER[i] falls on the 5th plus i
const weekdayOf = (code: string) => (ORDER.includes(code) ? formatWeekdayLong(new Date(2026, 0, 5 + ORDER.indexOf(code))) : code)

function joinWords(words: string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}

/**
 * The last day of an RRULE UNTIL. A timed UNTIL is a UTC instant, so it shows on the viewer's date for
 * that instant. A date UNTIL is that calendar date.
 */
function untilDate(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  if (match[4] === undefined) return new Date(year, month - 1, day)
  return match[7] ? new Date(Date.UTC(year, month - 1, day, hour, minute, second)) : new Date(year, month - 1, day, hour, minute, second)
}

/** "Weekly on Monday", "Every 2 weeks on Monday and Thursday", "Monthly on the second Tuesday", with the end when there is one */
export function recurrenceText(rule: string | null | undefined, start: Date): string {
  if (!rule) return ""
  const parts = new Map(rule.split(";").map((part) => part.split("=") as [string, string]))
  const interval = Number(parts.get("INTERVAL") ?? "1") || 1
  const every = (unit: string, plural: string) => (interval === 1 ? unit : `Every ${interval} ${plural}`)
  const byDay = (parts.get("BYDAY") ?? "").split(",").filter(Boolean)
  let text: string
  switch (parts.get("FREQ")) {
    case "DAILY":
      text = every("Daily", "days")
      break
    case "WEEKLY": {
      const days = byDay.length ? [...byDay].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)) : [ORDER[(start.getDay() + 6) % 7]]
      if (interval === 1 && days.join(",") === "MO,TU,WE,TH,FR") text = "Every weekday"
      else text = `${every("Weekly", "weeks")} on ${joinWords(days.map((day) => weekdayOf(day)))}`
      break
    }
    case "MONTHLY": {
      const nth = /^(-?\d)([A-Z]{2})$/.exec(byDay[0] ?? "")
      const setPos = parts.get("BYSETPOS")
      const ordinal = nth ? NTH[nth[1]] : setPos ? NTH[setPos] : undefined
      const weekday = nth ? weekdayOf(nth[2]) : byDay[0] ? weekdayOf(byDay[0]) : undefined
      const on = ordinal && weekday ? `the ${ordinal} ${weekday}` : `day ${parts.get("BYMONTHDAY") ?? start.getDate()}`
      text = `${every("Monthly", "months")} on ${on}`
      break
    }
    case "YEARLY":
      text = `${every("Annually", "years")} on ${formatDayMonth(start)}`
      break
    default:
      return "Repeats"
  }
  const count = Number(parts.get("COUNT"))
  const untilValue = parts.get("UNTIL")
  const until = untilValue ? untilDate(untilValue) : null
  if (count) return `${text}, ${count} ${count === 1 ? "time" : "times"}`
  if (until) return `${text}, until ${formatLongDate(until)}`
  return text
}

export function reminderText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return ""
  if (minutes === 0) return "At the start"
  if (minutes % 1440 === 0) return minutes === 1440 ? "1 day before" : `${minutes / 1440} days before`
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour before" : `${minutes / 60} hours before`
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} before`
}
