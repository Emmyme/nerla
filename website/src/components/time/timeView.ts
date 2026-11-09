import type { TimeEntry, TimeWeek } from "@/lib/api/time"
import { formatShortDate, formatWeekdayShort, parseDueDate, toDueDateValue } from "@/lib/dates"
import { mondayOf } from "@/lib/timeFormat"

export type RangePreset = "this-week" | "last-week" | "this-month" | "last-month" | "custom"

const iso = (date: Date) => date.toISOString().slice(0, 10)
const total = (items: { minutes: number }[]) => items.reduce((sum, item) => sum + item.minutes, 0)

/** A YYYY-MM-DD date moved by whole days */
export function shiftDate(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + days)
  return iso(day)
}

/** A real YYYY-MM-DD calendar day, or null */
export const calendarDay = (value: string | null | undefined): string | null =>
  value && /^\d{4}-\d{2}-\d{2}$/.test(value) && toDueDateValue(value) === value ? value : null

/** "Mon 27 Oct" */
export function dayName(date: string): string {
  const day = parseDueDate(date)
  return day ? `${formatWeekdayShort(day)} ${formatShortDate(day)}` : date
}

/** The week after a write: the entry on its day (in place when it stays), a removed one gone, a used suggestion gone */
export function applyToWeek(week: TimeWeek, change: { entry?: TimeEntry; removedId?: string; suggestionKey?: string }): TimeWeek {
  const changed = change.entry
  const id = changed?.id ?? change.removedId
  const days = week.days.map((day) => {
    const here = changed?.date === day.date ? changed : null
    const kept = day.entries.flatMap((entry) => (entry.id !== id ? [entry] : here ? [here] : []))
    const entries = here && !day.entries.some((entry) => entry.id === id) ? [...kept, here] : kept
    const suggestions = change.suggestionKey
      ? day.suggestions.filter((suggestion) => suggestion.key !== change.suggestionKey)
      : day.suggestions
    return { ...day, entries, suggestions, minutes: total(entries) }
  })
  return { ...week, days, minutes: total(days) }
}

/** The first and last day of a preset around today */
export function presetRange(preset: Exclude<RangePreset, "custom">, today: string): { from: string; to: string } {
  if (preset === "this-week" || preset === "last-week") {
    const from = shiftDate(mondayOf(today), preset === "last-week" ? -7 : 0)
    return { from, to: shiftDate(from, 6) }
  }
  const [year, month] = today.split("-").map(Number)
  const first = new Date(Date.UTC(year, month - (preset === "last-month" ? 2 : 1), 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0))
  return { from: iso(first), to: iso(last) }
}
