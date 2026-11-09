import { dayDiff, dayLength, parseServerDate, startOfDay, toInstant } from "@/lib/dates"
import type { TimeAxis } from "./layout"

const SNAP_MINUTES = 15
const MIN_EVENT_MINUTES = 15
const DAY_MINUTES = 1440
const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

/** Where the grid sits: its top edge and the height of one axis minute, in the pointer's units */
type GridGeometry = { axis: TimeAxis; top: number; minuteHeight: number }
/** `minutes` are real minutes after the local midnight of the slot's day */
export type Slot = { dayIndex: number; minutes: number; at: Date }
export type EventTimes = { starts_at: string; ends_at: string }
type Timed = { starts_at: string | null; ends_at: string | null; all_day: boolean }

export function snap(minutes: number, step = SNAP_MINUTES): number {
  return Math.round(minutes / step) * step
}

/** The slot under the pointer, floored to `step`, inside the day */
export function pointerToSlot(y: number, dayIndex: number, grid: GridGeometry, step = SNAP_MINUTES): Slot {
  const { axis } = grid
  const axisMinutes = Math.min(Math.max((y - grid.top) / grid.minuteHeight, 0), axis.minutes)
  const day = axis.days[dayIndex]
  const minutes = Math.min(Math.floor(axis.fromAxis(dayIndex, axisMinutes) / step) * step, dayLength(day) - step)
  return { dayIndex, minutes, at: toInstant(day, minutes) }
}

function times(event: Timed): { start: Date; end: Date } {
  const start = parseServerDate(event.starts_at)
  const end = parseServerDate(event.ends_at)
  if (!start || !end) throw new Error("Event has no valid times")
  return { start, end }
}

function iso(start: number, end: number): EventTimes {
  return { starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString() }
}

// Same wall-clock time on another date, so a 09:00 event stays at 09:00 over a daylight saving change
function shiftDays(date: Date, days: number): Date {
  if (days === 0) return date
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  )
}

/**
 * Moves an event by whole dates at the same wall-clock time, then by real minutes, keeping its
 * real length. All-day events move by UTC dates and ignore minutes.
 */
export function moveEvent(event: Timed, deltaMinutes: number, deltaDays: number): EventTimes {
  const { start, end } = times(event)
  if (event.all_day) return iso(start.getTime() + deltaDays * DAY_MS, end.getTime() + deltaDays * DAY_MS)
  const moved = shiftDays(start, deltaDays).getTime() + deltaMinutes * MINUTE_MS
  return iso(moved, moved + (end.getTime() - start.getTime()))
}

/** The `moveEvent` arguments that take `from` to `to`: whole local dates, then real minutes. All-day uses UTC dates. */
export function wallDelta(from: Date, to: Date, allDay = false): { days: number; minutes: number } {
  if (allDay) return { days: Math.round((to.getTime() - from.getTime()) / DAY_MS), minutes: 0 }
  const days = dayDiff(to, from)
  return { days, minutes: (to.getTime() - shiftDays(from, days).getTime()) / MINUTE_MS }
}

/** Moves the end by real minutes, keeping at least 15 minutes. All-day events resize by whole days, at least one. */
export function resizeEvent(event: Timed, deltaMinutes: number): EventTimes {
  const { start, end } = times(event)
  if (event.all_day) {
    const days = Math.round(deltaMinutes / DAY_MINUTES)
    return iso(start.getTime(), Math.max(start.getTime() + DAY_MS, end.getTime() + days * DAY_MS))
  }
  return iso(start.getTime(), Math.max(start.getTime() + MIN_EVENT_MINUTES * MINUTE_MS, end.getTime() + deltaMinutes * MINUTE_MS))
}

export type Range = { start: Date; end: Date }

/** The day column under `x`, inside the grid */
export function pointerToDay(x: number, left: number, width: number, count: number): number {
  if (width <= 0) return 0
  return Math.min(count - 1, Math.max(0, Math.floor(((x - left) / width) * count)))
}

/** A click on empty time makes the half hour it falls in */
export function tapRange(slot: Slot, minutes = 30): Range {
  const day = startOfDay(slot.at)
  const from = Math.max(0, Math.min(Math.floor(slot.minutes / minutes) * minutes, dayLength(day) - minutes))
  return { start: toInstant(day, from), end: toInstant(day, from + minutes) }
}

/** A drag over empty time runs from the earlier slot to the end of the later one, across days like Google */
export function dragRange(from: Slot, to: Slot, step = SNAP_MINUTES): Range {
  const [first, last] = from.at <= to.at ? [from, to] : [to, from]
  const lastDay = startOfDay(last.at)
  return { start: first.at, end: toInstant(lastDay, Math.min(last.minutes + step, dayLength(lastDay))) }
}

/** Day slots from a drag in the month or the all-day row, as an all-day range with the last day included */
export function dayRange(from: Slot, to: Slot): Range {
  const [first, last] = from.at <= to.at ? [from.at, to.at] : [to.at, from.at]
  return { start: startOfDay(first), end: startOfDay(last) }
}

/** Where a dragged event lands: moved by the dates and minutes between the slot grabbed and the slot under the pointer */
export function dragMove(event: Timed, grab: Slot, over: Slot): EventTimes {
  const { days, minutes } = wallDelta(grab.at, over.at)
  return moveEvent(event, event.all_day ? 0 : minutes, days)
}

/** The bottom edge follows the pointer in real minutes, all-day events by whole dates */
export function dragResize(event: Timed, grab: Slot, over: Slot): EventTimes {
  if (event.all_day) return resizeEvent(event, wallDelta(grab.at, over.at).days * DAY_MINUTES)
  return resizeEvent(event, (over.at.getTime() - grab.at.getTime()) / MINUTE_MS)
}

export type NudgeKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"

/**
 * Alt and the arrows move an event by 15 minutes or a day, and with Shift resize it. In the month,
 * where there are no minutes, up and down move by a week. Null when the key does nothing here.
 */
export function nudgeEvent(event: Timed, key: NudgeKey, { resize = false, month = false } = {}): EventTimes | null {
  const sign = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1
  const vertical = key === "ArrowUp" || key === "ArrowDown"
  if (resize) {
    if (event.all_day) return vertical ? null : resizeEvent(event, sign * DAY_MINUTES)
    return vertical ? resizeEvent(event, sign * SNAP_MINUTES) : null
  }
  if (!vertical) return moveEvent(event, 0, sign)
  if (month) return moveEvent(event, 0, sign * 7)
  return event.all_day ? null : moveEvent(event, sign * SNAP_MINUTES, 0)
}

/** The first half hour from now on that none of `busy` overlaps, today. Falls back to the next half hour. */
export function nextFreeHalfHour(now: Date, busy: Range[], minutes = 30): Range {
  const day = startOfDay(now)
  const length = dayLength(day)
  const first = Math.ceil((now.getTime() - day.getTime()) / MINUTE_MS / minutes) * minutes
  for (let at = first; at + minutes <= length; at += minutes) {
    const start = toInstant(day, at)
    const end = toInstant(day, at + minutes)
    if (!busy.some((range) => range.start < end && start < range.end)) return { start, end }
  }
  const start = toInstant(day, first)
  return { start, end: new Date(start.getTime() + minutes * MINUTE_MS) }
}
