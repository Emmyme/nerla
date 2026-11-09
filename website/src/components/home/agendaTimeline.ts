import { addDays, allDayRange, dayDiff, parseServerDate } from "@/lib/dates"

export type TimelineItem = { start: Date; end: Date; event: { all_day: boolean } }

type SpanEvent = { starts_at: string | null; ends_at: string | null; all_day: boolean }

/** One event on one of its days. `index` counts from 0 on the first day, out of `days`. */
export type DayEntry<E extends SpanEvent> = { event: E; day: Date; start: Date; end: Date; hasEnd: boolean; index: number; days: number }

/**
 * Every local day each event covers, keyed by that day's midnight and sorted all-day first, then by start.
 * `within` limits the days to the ones shown, first and last day included.
 */
export function eventsByDay<E extends SpanEvent>(events: E[], within?: { first: Date; last: Date }): Map<number, DayEntry<E>[]> {
  const byDay = new Map<number, DayEntry<E>[]>()
  for (const event of events) {
    const range = allDayRange(event)
    if (!range) continue
    const start = event.all_day ? range.first : parseServerDate(event.starts_at)
    if (!start) continue
    const end = event.all_day ? addDays(range.last, 1) : parseServerDate(event.ends_at)
    const hasEnd = !!end && end > start
    const days = dayDiff(range.last, range.first) + 1
    const from = within ? Math.max(0, dayDiff(within.first, range.first)) : 0
    const to = within ? Math.min(days - 1, dayDiff(within.last, range.first)) : days - 1
    for (let index = from; index <= to; index++) {
      const day = addDays(range.first, index)
      const entry: DayEntry<E> = { event, day, start, end: hasEnd ? end : start, hasEnd, index, days }
      const list = byDay.get(day.getTime())
      if (list) list.push(entry)
      else byDay.set(day.getTime(), [entry])
    }
  }
  for (const list of byDay.values()) list.sort(byStart)
  return byDay
}

function byStart(a: TimelineItem, b: TimelineItem): number {
  if (a.event.all_day !== b.event.all_day) return a.event.all_day ? -1 : 1
  return a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime()
}

export function hasEnded(item: TimelineItem, now: Date): boolean {
  return item.end <= now
}

export function isRunning(item: TimelineItem, now: Date): boolean {
  return !item.event.all_day && item.start <= now && now < item.end
}

// The Now line sits above the first timed event that has not started yet, so running events stay above it
export function nowLineIndex(items: TimelineItem[], now: Date): number {
  const index = items.findIndex((item) => !item.event.all_day && item.start > now)
  return index === -1 ? items.length : index
}
