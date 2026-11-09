import type { CalendarEntry, CalendarEvent } from "@/lib/api/calendar"
import { addDays, allDayRange, formatTime, parseServerDate, sameDay } from "@/lib/dates"
import { NO_TITLE } from "./items"

const MINUTE = 60_000
const DAY_MS = 86_400_000
// A timer can run a little late, so an at-the-start reminder still fires just after the start.
// A replan after sleep or on focus uses the same grace, so a reminder long past its start never fires.
const GRACE_MS = MINUTE
// All-day reminders come at this local hour, on the day or the day before
const ALL_DAY_HOUR = 9

/** `starts` for timed events, `today` and `tomorrow` for all-day ones. `until` is when a missed reminder stops firing. */
export type Reminder = { key: string; event: CalendarEvent; start: Date; at: number; until: number; kind: "starts" | "today" | "tomorrow" }

const atHour = (day: Date, hour: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime()

// An Everyone event reminds only its organizer and its guests
function involves(event: CalendarEvent, userId: string | null): boolean {
  return !!userId && (event.created_by === userId || event.attendees.some((guest) => guest.user_id === userId))
}

function reminderOf(entry: CalendarEntry, userId: string | null): Reminder | null {
  if (entry.busy) return null
  const event = entry
  const minutes = event.reminder_minutes
  if (minutes === null || event.id.startsWith("temp-") || event.viewer_response === "no") return null
  if (event.everyone && !involves(event, userId)) return null
  if (event.all_day) {
    const first = allDayRange(event)?.first
    if (!first) return null
    const dayBefore = minutes >= 1440
    return {
      key: `${event.occurrence_id}@${first.getTime()}`,
      event,
      start: first,
      at: atHour(dayBefore ? addDays(first, -1) : first, ALL_DAY_HOUR),
      until: (dayBefore ? first : addDays(first, 1)).getTime(),
      kind: dayBefore ? "tomorrow" : "today",
    }
  }
  const start = parseServerDate(event.starts_at)
  if (!start) return null
  return {
    key: `${event.occurrence_id}@${start.getTime()}`,
    event,
    start,
    at: start.getTime() - minutes * MINUTE,
    until: start.getTime(),
    kind: "starts",
  }
}

/**
 * The reminders to show now, the time of the next one, and the key of every reminder planned. A reminder
 * whose time passed fires once while its event has not started, as when the app opens four minutes before
 * a ten-minute reminder's event. An all-day event counts as not started through its first day.
 */
export function planReminders(
  events: CalendarEntry[],
  now: number,
  fired: ReadonlySet<string>,
  userId: string | null,
): { due: Reminder[]; nextAt: number | null; keys: Set<string> } {
  const due: Reminder[] = []
  const keys = new Set<string>()
  let nextAt: number | null = null
  for (const entry of events) {
    const reminder = reminderOf(entry, userId)
    if (!reminder) continue
    keys.add(reminder.key)
    if (fired.has(reminder.key)) continue
    if (reminder.at > now) nextAt = nextAt === null ? reminder.at : Math.min(nextAt, reminder.at)
    else if (now < reminder.until || now - reminder.at < GRACE_MS) due.push(reminder)
  }
  return { due, nextAt, keys }
}

/** "Design review starts in 10 minutes", "starts in 1 hour", "starts tomorrow" or "starts now" */
export function startsText(title: string, start: Date, now: Date, minutes: number): string {
  const left = Math.ceil((start.getTime() - now.getTime()) / MINUTE)
  let when: string
  if (left <= 0) when = "now"
  else if (left < 60) when = `in ${left} ${left === 1 ? "minute" : "minutes"}`
  else if (left === 60) when = "in 1 hour"
  else if (minutes === 1440 && sameDay(start, addDays(now, 1))) when = "tomorrow"
  else when = `at ${formatTime(start)}`
  return `${title} starts ${when}`
}

export function reminderTitle(reminder: Reminder, now: Date): string {
  const title = reminder.event.title.trim() || NO_TITLE
  if (reminder.kind === "today") return `${title} is today`
  if (reminder.kind === "tomorrow") return `${title} is tomorrow`
  return startsText(title, reminder.start, now, reminder.event.reminder_minutes ?? 0)
}

/** Fired keys end in their start, so a day after it the key can go */
export function pruneFired(keys: Iterable<string>, now: number): string[] {
  return [...keys].filter((key) => {
    const start = Number(key.slice(key.lastIndexOf("@") + 1))
    return Number.isFinite(start) && start > now - DAY_MS
  })
}
