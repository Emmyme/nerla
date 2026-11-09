import { useCallback, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { AnchoredPopover } from "@/components/ui/anchored-popover"
import {
  addDays,
  allDayRange,
  formatDayTitle,
  formatShortDate,
  formatTime,
  formatWeekdayShort,
  sameDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "@/lib/dates"
import type { EventType } from "@/lib/eventColors"
import { cn, remPx } from "@/lib/utils"
import { EventBar, EventChip, GhostBlock, type OpenItem } from "./EventBlock"
import { itemTitle, NO_TITLE, type CalendarItem } from "./items"
import { draftTitle } from "./draft"
import { useNow } from "./useNow"
import { monthCells, type MonthCell } from "./layout"
import { dayRange, dragMove, pointerToDay, type Slot } from "./timeMath"
import { segmentsOf } from "./viewMath"
import { dragPreview, pressTarget, useDrop, useGridPointer, type GridActions } from "./useGridPointer"

const HEAD_REM = 1.85
const LANE_REM = 1.375
const MIN_LANES = 2

function eventCount(cell: MonthCell<CalendarItem>): string {
  const count = cell.all.length
  return count === 0 ? "" : `, ${count} ${count === 1 ? "event" : "events"}`
}

/** Where a bar sits in its week row, inset from the cell edges where it does not run on */
function barPosition(lane: number, start: number, span: number, continuesBefore: boolean, continuesAfter: boolean) {
  return {
    top: `${HEAD_REM + lane * LANE_REM}rem`,
    left: `calc(${(start / 7) * 100}% + ${continuesBefore ? 0 : 0.25}rem)`,
    width: `calc(${(span / 7) * 100}% - ${(continuesBefore ? 0 : 0.25) + (continuesAfter ? 0 : 0.3125)}rem)`,
  }
}

type MonthGhost = { first: Date; last: Date; title: string; type?: EventType; item?: CalendarItem; anchor: boolean }

/**
 * The 6 by 7 month: day numbers, bars for all-day and multi-day events, timed chips, and "+N more".
 * A click on a day makes an all-day draft, a drag over days a longer one, and events move by days.
 */
export function MonthView({
  month,
  items,
  label,
  narrow = false,
  onOpen,
  onShowDay,
  draft = null,
  dismissing = false,
  canMove,
  onCreate,
  onChangeTimes,
  onNudge,
}: {
  month: Date
  items: CalendarItem[]
  label: string
  narrow?: boolean
  onOpen?: OpenItem
  onShowDay?: (day: Date) => void
} & GridActions) {
  const now = useNow()
  const root = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const firstRow = useRef<HTMLDivElement>(null)
  const [lanes, setLanes] = useState(3)
  const [more, setMore] = useState<{ cell: MonthCell<CalendarItem>; anchor: HTMLElement } | null>(null)
  const monthKey = startOfMonth(month).getTime()

  useLayoutEffect(() => {
    const row = firstRow.current
    if (!row) return
    const measure = () => {
      const height = row.getBoundingClientRect().height / remPx()
      setLanes(Math.max(MIN_LANES, Math.floor((height - HEAD_REM - 0.25) / LANE_REM)))
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [])

  const cells = useMemo(() => monthCells(new Date(monthKey), items, lanes), [monthKey, items, lanes])
  const weeks = Array.from({ length: 6 }, (_, w) => cells.slice(w * 7, w * 7 + 7))
  const weekdays = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(new Date(monthKey)), i))
  const moreLane = lanes - 1
  const byKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items])
  const { held, drop } = useDrop(onChangeTimes)

  const slotAt = useCallback(
    (x: number, y: number): Slot | null => {
      const node = grid.current
      if (!node) return null
      const rect = node.getBoundingClientRect()
      const col = pointerToDay(x, rect.left, rect.width, 7)
      const row = pointerToDay(y, rect.top, rect.height, 6)
      const index = row * 7 + col
      return { dayIndex: index, minutes: 0, at: cells[index].day }
    },
    [cells],
  )

  const pointer = useGridPointer<CalendarItem>({
    slotAt,
    scroller: root,
    autoscroll: false,
    dismissing,
    onTap: (slot) => onCreate?.({ start: slot.at, end: slot.at }, true),
    onSelect: (from, to) => onCreate?.(dayRange(from, to), true),
    onDrop: (target, from, to) => drop(target.item, dragMove(target.item, from, to)),
  })

  const preview = dragPreview(pointer.drag) ?? held
  const ghosts: MonthGhost[] = []
  if (pointer.drag?.target.kind === "empty") {
    const range = dayRange(pointer.drag.from, pointer.drag.to)
    ghosts.push({ first: range.start, last: range.end, title: NO_TITLE, anchor: false })
  } else if (draft && !draft.event) {
    const last = draft.allDay ? draft.end : startOfDay(new Date(Math.max(draft.start.getTime(), draft.end.getTime() - 1)))
    const title = draftTitle(draft)
    ghosts.push({
      first: startOfDay(draft.start),
      last,
      title: draft.allDay ? title : `${formatTime(draft.start)} ${title}`,
      type: draft.type,
      anchor: true,
    })
  }
  const previewRange = preview ? allDayRange(preview) : null
  if (preview && previewRange)
    ghosts.push({ first: previewRange.first, last: previewRange.last, title: itemTitle(preview), item: preview, anchor: false })
  const draggingKey = preview?.key

  const movable = (item: CalendarItem) => {
    const can = !!canMove?.(item)
    return { draggable: can, dragging: item.key === draggingKey, onNudge: can ? onNudge : undefined }
  }

  const press = (event: ReactPointerEvent) => {
    const target = pressTarget(event, byKey)
    if (target) pointer.start(event, target)
  }

  // A ghost takes the first lane free in every cell it covers, or the last lane when they are full
  const ghostPieces = (week: MonthCell<CalendarItem>[]) =>
    ghosts.flatMap((ghost, g) => {
      const from = week.findIndex((cell) => cell.day >= startOfDay(ghost.first))
      const to = week.reduce((last, cell, index) => (cell.day <= ghost.last ? index : last), -1)
      if (from === -1 || to === -1 || from > to) return []
      const used = Math.max(
        -1,
        ...week.slice(from, to + 1).flatMap((cell) => (cell.more > 0 ? [moreLane] : cell.items.map((entry) => entry.lane))),
      )
      return [
        {
          ghost,
          key: `${ghost.item?.key ?? "draft"}|${g}|${week[0].key}`,
          lane: Math.min(used + 1, moreLane),
          start: from,
          span: to - from + 1,
          continuesBefore: week[from].day > startOfDay(ghost.first),
          continuesAfter: week[to].day < ghost.last,
          anchor:
            ghost.anchor &&
            (week[from].day.getTime() === startOfDay(ghost.first).getTime() || (from === 0 && week[0].key === cells[0].key)),
        },
      ]
    })

  return (
    <div ref={root} role="table" aria-label={label} className="flex min-h-0 flex-1 flex-col select-none">
      <div role="row" className="grid grid-cols-7 border-b-[0.0625rem] border-border">
        {weekdays.map((day) => (
          <span
            key={day.getTime()}
            role="columnheader"
            aria-label={formatWeekdayShort(day)}
            className="py-2 text-center text-micro font-medium text-muted-foreground"
          >
            {formatWeekdayShort(day)}
          </span>
        ))}
      </div>
      <div ref={grid} onPointerDown={press} className="grid min-h-0 flex-1 grid-rows-6">
        {weeks.map((week, w) => {
          const segments = segmentsOf(week)
          const pieces = ghostPieces(week)
          return (
            <div
              key={week[0].key}
              ref={w === 0 ? firstRow : undefined}
              role="row"
              className={cn("relative grid min-h-0 grid-cols-7", w > 0 && "border-t-[0.0625rem] border-border")}
            >
              {week.map((cell, index) => {
                const isToday = sameDay(cell.day, now)
                const first = cell.day.getDate() === 1
                return (
                  <div key={cell.key} role="cell" className={cn("min-w-0", index > 0 && "border-l-[0.0625rem] border-border")}>
                    <div className="flex justify-center pt-1" style={{ height: `${HEAD_REM}rem` }}>
                      <button
                        type="button"
                        aria-label={`Day view for ${formatDayTitle(cell.day)}${isToday ? ", today" : ""}${eventCount(cell)}`}
                        aria-current={isToday ? "date" : undefined}
                        onClick={() => onShowDay?.(cell.day)}
                        className={cn(
                          "flex h-[1.5rem] min-w-[1.5rem] items-center justify-center rounded-full px-1 text-caption font-medium tabular-nums transition-colors duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
                          isToday
                            ? "bg-app-sky text-app-sky-ink"
                            : cn("hover:bg-app-hover", cell.inMonth ? "text-foreground" : "text-muted-foreground"),
                        )}
                      >
                        {first ? formatShortDate(cell.day, now) : cell.day.getDate()}
                      </button>
                    </div>
                    {segments[index].map((segment) => {
                      const position = barPosition(
                        segment.item.lane,
                        segment.start,
                        segment.span,
                        segment.continuesBefore,
                        segment.continuesAfter,
                      )
                      return segment.item.bar || narrow ? (
                        <EventBar
                          key={`${segment.item.event.key}|${segment.start}`}
                          item={segment.item.event}
                          now={now}
                          continuesBefore={segment.continuesBefore}
                          continuesAfter={segment.continuesAfter}
                          compact={narrow}
                          onOpen={onOpen}
                          {...movable(segment.item.event)}
                          className="absolute z-10"
                          style={position}
                        />
                      ) : (
                        <EventChip
                          key={segment.item.event.key}
                          item={segment.item.event}
                          now={now}
                          onOpen={onOpen}
                          {...movable(segment.item.event)}
                          className="absolute z-10"
                          style={position}
                        />
                      )
                    })}
                    {cell.more > 0 && (
                      <button
                        type="button"
                        aria-label={`${cell.more} more ${cell.more === 1 ? "event" : "events"} on ${formatDayTitle(cell.day)}`}
                        onClick={(e) => setMore({ cell, anchor: e.currentTarget })}
                        className="absolute z-10 flex h-[1.25rem] items-center rounded-md px-1 text-caption font-medium whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
                        style={{
                          top: `${HEAD_REM + moreLane * LANE_REM}rem`,
                          left: `calc(${(index / 7) * 100}% + 0.25rem)`,
                          maxWidth: "calc(100% / 7 - 0.5rem)",
                        }}
                      >
                        +{cell.more}
                        {!narrow && " more"}
                      </button>
                    )}
                  </div>
                )
              })}
              {pieces.map((piece) => (
                <GhostBlock
                  key={piece.key}
                  bar
                  anchor={piece.anchor}
                  title={piece.ghost.title}
                  type={piece.ghost.type}
                  item={piece.ghost.item}
                  continuesBefore={piece.continuesBefore}
                  continuesAfter={piece.continuesAfter}
                  className={narrow ? "px-1 text-micro" : undefined}
                  style={barPosition(piece.lane, piece.start, piece.span, piece.continuesBefore, piece.continuesAfter)}
                />
              ))}
            </div>
          )
        })}
      </div>

      <AnchoredPopover
        open={!!more}
        onOpenChange={(open) => !open && setMore(null)}
        anchor={more?.anchor ?? null}
        side="bottom"
        title={more ? formatDayTitle(more.cell.day) : ""}
        className="w-[16rem] p-3"
      >
        {more && (
          <>
            <div className="mb-2.5 flex flex-col items-center gap-0.5">
              <span className="text-micro font-medium text-muted-foreground">{formatWeekdayShort(more.cell.day)}</span>
              <button
                type="button"
                aria-label={`Day view for ${formatDayTitle(more.cell.day)}`}
                onClick={() => {
                  setMore(null)
                  onShowDay?.(more.cell.day)
                }}
                className={cn(
                  "flex size-[2.4rem] items-center justify-center rounded-full text-title font-semibold tabular-nums transition-colors duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
                  sameDay(more.cell.day, now) ? "bg-app-sky text-app-sky-ink" : "text-foreground hover:bg-app-hover",
                )}
              >
                {more.cell.day.getDate()}
              </button>
            </div>
            <ul aria-label={`Events on ${formatDayTitle(more.cell.day)}`} className="flex flex-col gap-0.5">
              {more.cell.all.map((entry) => (
                <li key={entry.event.key}>
                  {entry.bar ? (
                    <EventBar
                      item={entry.event}
                      now={now}
                      continuesBefore={entry.continuesBefore}
                      continuesAfter={entry.continuesAfter}
                      onOpen={onOpen}
                      className="w-full"
                    />
                  ) : (
                    <EventChip item={entry.event} now={now} onOpen={onOpen} className="w-full" />
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </AnchoredPopover>
    </div>
  )
}
