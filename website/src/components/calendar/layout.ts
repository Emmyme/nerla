import { addDays, allDayRange, dayDiff, dayKey, dayLength, parseServerDate, startOfDay, startOfMonth, startOfWeek } from "@/lib/dates"

/** Anything with the event time fields: full events and busy rows */
export type Positioned = { starts_at: string | null; ends_at: string | null; all_day: boolean }

/**
 * Minutes are real minutes after the day's local midnight, so a 25-hour day runs to 1500. `depth` is
 * how many indents the block sits in, and `left` and `width` are fractions of the space after them.
 */
type Block<T> = {
  event: T
  start: Date
  end: Date
  top: number
  height: number
  col: number
  cols: number
  span: number
  depth: number
  left: number
  width: number
}

type AllDayBar<T> = { event: T; start: number; span: number; continuesBefore: boolean; continuesAfter: boolean }
type AllDayRow<T> = AllDayBar<T>[]

export type MonthItem<T> = {
  event: T
  lane: number
  bar: boolean
  /** The item's piece of a bar starts in this cell, true for single-day items */
  first: boolean
  /** Days from this cell to the end of the piece within the week */
  span: number
  continuesBefore: boolean
  continuesAfter: boolean
}
export type MonthCell<T> = { day: Date; key: string; inMonth: boolean; items: MonthItem<T>[]; more: number; all: MonthItem<T>[] }

export type AxisRow = { at: Date; hour: number; repeated: boolean }
/** The shared vertical axis of a time grid, in minutes. Day minutes are real minutes after local midnight. */
export type TimeAxis = {
  days: Date[]
  rows: AxisRow[]
  minutes: number
  toAxis: (dayIndex: number, minutes: number) => number
  fromAxis: (dayIndex: number, axisMinutes: number) => number
}

const MIN_BLOCK_MINUTES = 20
/** A later event that starts this many minutes after the events it overlaps is indented on top of them */
const INDENT_AFTER_MINUTES = 30
/** A block that is not in the last column reaches this many slots, under the later blocks to its right */
const OVERLAP_SLOTS = 1.7
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

function timesOf(event: Positioned): { start: Date; end: Date } | null {
  const start = parseServerDate(event.starts_at)
  const end = parseServerDate(event.ends_at)
  if (!start || !end) return null
  return { start, end: end > start ? end : start }
}

/** Google's rule: all-day events and timed events of 24 hours or more sit in the all-day row */
export function inAllDayRow(event: Positioned): boolean {
  if (event.all_day) return true
  const times = timesOf(event)
  return !!times && times.end.getTime() - times.start.getTime() >= DAY_MS
}

function overlaps(a: { top: number; bottom: number }, b: { top: number; bottom: number }) {
  return a.top < b.bottom && b.top < a.bottom
}

/**
 * Lays out one day's timed events Google style. Overlapping events form a cluster. Events that start
 * within half an hour of each other share columns, each in the first free column and widened into free
 * columns to its right, and a block reaches 1.7 slots under its later neighbours. An event that starts
 * half an hour or more after everything it overlaps is indented on top instead.
 * `keepLong` draws events of 24 hours or more here too, as a drag selection does.
 */
export function layoutDay<T extends Positioned>(events: T[], dayStart: Date, keepLong = false): Block<T>[] {
  const start = startOfDay(dayStart).getTime()
  const length = dayLength(dayStart)
  type Placed = { event: T; start: Date; end: Date; top: number; height: number; bottom: number; col: number; group: Group }
  type Group = { depth: number; columns: Placed[][] }
  const placed = events
    .flatMap((event) => {
      if (event.all_day || (!keepLong && inAllDayRow(event))) return []
      const times = timesOf(event)
      if (!times) return []
      const from = (times.start.getTime() - start) / 60000
      const to = (times.end.getTime() - start) / 60000
      if (to <= 0 || from >= length || (from === to && from < 0)) return []
      const height = Math.max(MIN_BLOCK_MINUTES, Math.min(length, to) - Math.max(0, from))
      // A short event at the end of the day moves up so its block stays inside the day
      const top = Math.max(0, Math.min(from, length - height))
      return [{ event, ...times, top, height, bottom: top + height, col: 0, group: null as unknown as Group }]
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom)

  placed.forEach((block, index) => {
    const over = placed.slice(0, index).filter((other) => overlaps(block, other))
    const near = over.filter((other) => block.top - other.top < INDENT_AFTER_MINUTES)
    if (near.length > 0) block.group = near[near.length - 1].group
    else block.group = { depth: over.length > 0 ? Math.max(...over.map((other) => other.group.depth)) + 1 : 0, columns: [] }
    const { columns } = block.group
    const free = columns.findIndex((column) => column[column.length - 1].bottom <= block.top)
    block.col = free === -1 ? columns.length : free
    ;(columns[block.col] ??= []).push(block)
  })

  return placed.map(({ event, start, end, top, height, col, group }) => {
    const cols = group.columns.length
    let span = 1
    while (col + span < cols && !group.columns[col + span].some((other) => overlaps({ top, bottom: top + height }, other))) span++
    const width = col + span >= cols ? span / cols : Math.min((cols - col) / cols, (span - 1 + OVERLAP_SLOTS) / cols)
    return { event, start, end, top, height, col, cols, span, depth: group.depth, left: col / cols, width }
  })
}

/** Hour rows of each day merged by wall-clock hour, so 09:00 lines up on a 23, 24 and 25-hour day */
export function timeAxis(days: Date[]): TimeAxis {
  const segments = days.map((day) => {
    const start = startOfDay(day).getTime()
    const count = Math.ceil(dayLength(day) / 60)
    const seen = new Map<number, number>()
    return Array.from({ length: count }, (_, k) => {
      const at = new Date(start + k * HOUR_MS)
      const hour = at.getHours()
      const repeat = seen.get(hour) ?? 0
      seen.set(hour, repeat + 1)
      return { at, hour, repeat, key: hour * 4 + Math.min(repeat, 3) }
    })
  })
  const byKey = new Map<number, AxisRow>()
  for (const day of segments)
    for (const seg of day) if (!byKey.has(seg.key)) byKey.set(seg.key, { at: seg.at, hour: seg.hour, repeated: seg.repeat > 0 })
  const keys = [...byKey.keys()].sort((a, b) => a - b)
  const rowOf = new Map(keys.map((key, index) => [key, index]))
  const rowsOfDay = segments.map((day) => day.map((seg) => rowOf.get(seg.key)!))

  const toAxis = (dayIndex: number, minutes: number) => {
    const rows = rowsOfDay[dayIndex]
    const k = Math.floor(minutes / 60)
    if (k < 0) return rows[0] * 60 + minutes
    if (k >= rows.length) return (rows[rows.length - 1] + 1) * 60 + (minutes - rows.length * 60)
    return rows[k] * 60 + (minutes - k * 60)
  }

  const fromAxis = (dayIndex: number, axisMinutes: number) => {
    const rows = rowsOfDay[dayIndex]
    const row = Math.floor(axisMinutes / 60)
    const k = rows.indexOf(row)
    if (k !== -1) return k * 60 + (axisMinutes - row * 60)
    const next = rows.findIndex((r) => r > row)
    return next === -1 ? rows.length * 60 : next * 60
  }

  return { days, rows: keys.map((key) => byKey.get(key)!), minutes: keys.length * 60, toAxis, fromAxis }
}

type Piece<T> = {
  event: T
  start: number
  end: number
  continuesBefore: boolean
  continuesAfter: boolean
  startMs: number
  allDay: boolean
}

function piecesIn<T extends Positioned>(
  events: T[],
  days: Date[],
  keep: (event: T, range: { first: Date; last: Date }) => boolean,
): Piece<T>[] {
  if (days.length === 0) return []
  return events
    .flatMap((event) => {
      const range = allDayRange(event)
      if (!range || !keep(event, range)) return []
      const from = dayDiff(range.first, days[0])
      const to = dayDiff(range.last, days[0])
      if (to < 0 || from > days.length - 1) return []
      const startMs = parseServerDate(event.starts_at)?.getTime() ?? 0
      return [
        {
          event,
          start: Math.max(0, from),
          end: Math.min(days.length - 1, to),
          continuesBefore: from < 0,
          continuesAfter: to > days.length - 1,
          startMs,
          allDay: event.all_day,
        },
      ]
    })
    .sort(
      (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs,
    )
}

function packPieces<T>(pieces: Piece<T>[], width: number, taken: boolean[][] = []): { piece: Piece<T>; lane: number }[] {
  return pieces.map((piece) => {
    let lane = 0
    while (taken[lane]?.slice(piece.start, piece.end + 1).some(Boolean)) lane++
    taken[lane] ??= Array.from({ length: width }, () => false)
    for (let i = piece.start; i <= piece.end; i++) taken[lane][i] = true
    return { piece, lane }
  })
}

// One overflow rule for the all-day row and month cells: when anything is hidden, the last slot becomes "+N more"
function visibleLanes(lanes: number[], max: number): number {
  return lanes.some((lane) => lane >= max) ? Math.max(0, max - 1) : max
}

/**
 * Packs all-day bars over consecutive days into the fewest rows. When bars do not fit in `maxRows`,
 * `maxRows - 1` rows show and every hidden bar counts in `overflow` for each day it covers.
 */
export function packAllDay<T extends Positioned>(
  events: T[],
  days: Date[],
  maxRows = Infinity,
): { rows: AllDayRow<T>[]; overflow: Map<string, number> } {
  const packed = packPieces(
    piecesIn(events, days, (event) => inAllDayRow(event)),
    days.length,
  )
  const limit = visibleLanes(
    packed.map(({ lane }) => lane),
    maxRows,
  )
  const rows: AllDayRow<T>[] = []
  const overflow = new Map<string, number>()
  for (const { piece, lane } of packed) {
    if (lane >= limit) {
      for (let i = piece.start; i <= piece.end; i++) overflow.set(dayKey(days[i]), (overflow.get(dayKey(days[i])) ?? 0) + 1)
      continue
    }
    ;(rows[lane] ??= []).push({
      event: piece.event,
      start: piece.start,
      span: piece.end - piece.start + 1,
      continuesBefore: piece.continuesBefore,
      continuesAfter: piece.continuesAfter,
    })
  }
  return { rows: rows.filter(Boolean), overflow }
}

/**
 * The 6 by 7 month grid. Per week, bars (all-day and multi-day events) are packed first and keep one
 * lane across their days, then each day's timed events fill the free lanes in time order. When a cell
 * cannot show every item within `maxPerCell` lanes, it shows `maxPerCell - 1` and counts the rest in `more`.
 */
export function monthCells<T extends Positioned>(month: Date, events: T[], maxPerCell: number): MonthCell<T>[] {
  const gridStart = startOfWeek(startOfMonth(month))
  const cells: MonthCell<T>[] = []
  for (let week = 0; week < 6; week++) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(gridStart, week * 7 + i))
    const isBar = (event: T, range: { first: Date; last: Date }) => event.all_day || range.last > range.first
    const taken: boolean[][] = []
    const bars = packPieces(piecesIn(events, days, isBar), 7, taken)
    const singles = packPieces(
      piecesIn(events, days, (event, range) => !isBar(event, range)),
      7,
      taken,
    )
    const byDay = days.map(() => [] as MonthItem<T>[])
    for (const { piece, lane } of [...bars, ...singles]) {
      for (let i = piece.start; i <= piece.end; i++) {
        byDay[i].push({
          event: piece.event,
          lane,
          bar: piece.event.all_day || piece.start !== piece.end || piece.continuesBefore || piece.continuesAfter,
          first: i === piece.start,
          span: piece.end - i + 1,
          continuesBefore: i > piece.start || piece.continuesBefore,
          continuesAfter: i < piece.end || piece.continuesAfter,
        })
      }
    }
    days.forEach((day, i) => {
      const all = byDay[i].sort((a, b) => a.lane - b.lane)
      const limit = visibleLanes(
        all.map((item) => item.lane),
        maxPerCell,
      )
      const items = all.filter((item) => item.lane < limit)
      cells.push({ day, key: dayKey(day), inMonth: day.getMonth() === month.getMonth(), items, more: all.length - items.length, all })
    })
  }
  return cells
}
