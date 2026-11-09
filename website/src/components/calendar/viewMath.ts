import { addDays, allDayRange, dayKey, formatTime, formatTimeRange, sameDay } from "@/lib/dates"
import { itemTimes, itemTitle, type CalendarItem } from "./items"
import type { MonthCell, MonthItem } from "./layout"

type Segment = { item: MonthItem<CalendarItem>; start: number; span: number; continuesBefore: boolean; continuesAfter: boolean }

// A bar shows as one piece per run of days where its lane is visible, so a cell that overflows breaks it
export function segmentsOf(week: MonthCell<CalendarItem>[]): Segment[][] {
  const byCell: Segment[][] = week.map(() => [])
  const open = new Map<string, Segment>()
  week.forEach((cell, index) => {
    const here = new Set<string>()
    for (const item of cell.items) {
      const key = `${item.event.key}|${item.lane}`
      here.add(key)
      const running = item.bar ? open.get(key) : undefined
      if (running && running.start + running.span === index) {
        running.span += 1
        running.continuesAfter = item.continuesAfter
        continue
      }
      const segment = {
        item,
        start: index,
        span: 1,
        continuesBefore: item.bar && item.continuesBefore,
        continuesAfter: item.bar && item.continuesAfter,
      }
      byCell[index].push(segment)
      if (item.bar) open.set(key, segment)
    }
    for (const key of [...open.keys()]) if (!here.has(key)) open.delete(key)
  })
  return byCell
}

type ScheduleRow = { item: CalendarItem; time: string }
type ScheduleDay = { day: Date; key: string; rows: ScheduleRow[] }

const sortKey = (item: CalendarItem) => (item.all_day ? 0 : 1)

function rowTime(item: CalendarItem, day: Date, first: Date, last: Date): string {
  if (item.all_day) return "All day"
  const times = itemTimes(item)
  if (!times) return ""
  if (first.getTime() === last.getTime()) return formatTimeRange(times.start, times.end)
  if (sameDay(day, first)) return `From ${formatTime(times.start)}`
  if (sameDay(day, last)) return `Until ${formatTime(times.end)}`
  return "All day"
}

// Every day an event covers gets a row, as in Google's schedule. Empty days are left out, except today.
export function groupByDay(items: CalendarItem[], from: Date, to: Date, today: Date): ScheduleDay[] {
  const days = new Map<string, ScheduleDay>()
  for (const item of items) {
    const range = allDayRange(item)
    if (!range) continue
    for (let day = range.first < from ? from : range.first; day <= range.last && day < to; day = addDays(day, 1)) {
      const key = dayKey(day)
      const entry = days.get(key) ?? { day, key, rows: [] }
      entry.rows.push({ item, time: rowTime(item, day, range.first, range.last) })
      days.set(key, entry)
    }
  }
  if (today >= from && today < to && !days.has(dayKey(today))) days.set(dayKey(today), { day: today, key: dayKey(today), rows: [] })
  const startOf = (row: ScheduleRow) => (row.item.all_day ? 0 : (itemTimes(row.item)?.start.getTime() ?? 0))
  for (const day of days.values()) {
    day.rows.sort(
      (a, b) => sortKey(a.item) - sortKey(b.item) || startOf(a) - startOf(b) || itemTitle(a.item).localeCompare(itemTitle(b.item)),
    )
  }
  return [...days.values()].sort((a, b) => a.day.getTime() - b.day.getTime())
}

/** Weeks of a list loaded so far, `to` exclusive */
export type Loaded<T> = { from: number; to: number; items: T[] }

function spans(item: CalendarItem, from: number, to: number): boolean {
  const range = allDayRange(item)
  return !!range && range.first.getTime() < to && addDays(range.last, 1).getTime() > from
}

/** Replaces what is known about `from` to `to` with `incoming`, and keeps the rest of the loaded weeks */
export function mergeLoaded<T extends CalendarItem>(shown: Loaded<T> | null, from: number, to: number, incoming: T[]): Loaded<T> {
  if (!shown || to < shown.from || from > shown.to) return { from, to, items: incoming }
  const byKey = new Map<string, T>()
  for (const item of shown.items) if (!spans(item, from, to)) byKey.set(item.key, item)
  for (const item of incoming) byKey.set(item.key, item)
  return { from: Math.min(shown.from, from), to: Math.max(shown.to, to), items: [...byKey.values()] }
}
