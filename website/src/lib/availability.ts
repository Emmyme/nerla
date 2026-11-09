import {
  formatShortDate,
  formatTime,
  formatWeekdayShort,
  parseDueDate,
  parseServerDate,
  sameDay,
  startOfDay,
  wallTimeIn,
} from "@/lib/dates"

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
export type Weekday = (typeof WEEKDAYS)[number]
export type DayHours = { start: string; end: string }
export type WorkingHours = Partial<Record<Weekday, DayHours>>

export type AvailabilityKind = "ooo" | "busy" | "meeting" | "focus" | "off_hours"
/** `until` is an ISO instant, or a YYYY-MM-DD last day for an all-day out of office */
export type Availability = { kind: AvailabilityKind | null; until?: string; note?: string }

const DAY_MS = 86_400_000

/** An end time in the viewer's zone: "15:00" today, "Fri 09:00" this week, with the date when further or asked for */
export function formatUntil(until: Date, now: Date, viewerZone: string, withDate = false, locale?: string): string {
  const today = wallTimeIn(now, viewerZone)
  const wall = wallTimeIn(until, viewerZone)
  const time = formatTime(wall, locale)
  if (sameDay(wall, today)) return time
  const far = startOfDay(wall).getTime() - startOfDay(today).getTime() >= 7 * DAY_MS
  const day = withDate || far ? `${formatWeekdayShort(wall)} ${formatShortDate(wall, today)}` : formatWeekdayShort(wall)
  return `${day} ${time}`
}

/**
 * The tooltip text for a user's availability, in the viewer's zone, such as "Busy, in a meeting until 15:00"
 * or "Outside working hours, back Mon 09:00". An out of office title the viewer may see follows on a second line.
 * Null when there is nothing to say, or when the state has already ended.
 */
export function availabilityText(
  availability: Availability | null | undefined,
  now: Date,
  viewerZone: string,
  locale?: string,
): string | null {
  if (!availability?.kind || !availability.until) return null
  const today = wallTimeIn(now, viewerZone)
  const when = (until: Date, withDate: boolean) => formatUntil(until, now, viewerZone, withDate, locale)

  if (availability.kind === "ooo" && /^\d{4}-\d{2}-\d{2}$/.test(availability.until)) {
    const last = parseDueDate(availability.until)
    if (!last || last < startOfDay(today)) return null
    const text = sameDay(last, today)
      ? "Out of office today"
      : `Out of office until ${formatWeekdayShort(last)} ${formatShortDate(last, today)}`
    return availability.note ? `${text}\n${availability.note}` : text
  }

  const until = parseServerDate(availability.until)
  if (!until || until <= now) return null
  switch (availability.kind) {
    case "ooo": {
      const text = `Out of office until ${when(until, true)}`
      return availability.note ? `${text}\n${availability.note}` : text
    }
    case "meeting":
      return `Busy, in a meeting until ${when(until, false)}`
    case "focus":
      return `Busy, focusing until ${when(until, false)}`
    case "busy":
      return `Busy until ${when(until, false)}`
    case "off_hours": {
      const back = when(until, false)
      return `Outside working hours, back ${sameDay(wallTimeIn(until, viewerZone), today) ? `at ${back}` : back}`
    }
  }
}
