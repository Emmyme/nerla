import { useCallback, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { ChevronDown } from "@/components/icons"
import { addDays, dayKey, formatDayTitle, formatTime, formatWeekdayShort, minutesOfDay, sameDay } from "@/lib/dates"
import { cn, remPx } from "@/lib/utils"
import { EventBar, EventBlock, GhostBlock, type OpenItem } from "./EventBlock"
import { itemTimeText, itemTitle, NO_TITLE, type CalendarItem } from "./items"
import { useNow } from "./useNow"
import { inAllDayRow, layoutDay, packAllDay, timeAxis, type Positioned } from "./layout"
import { draftTimes, draftTitle, type EventDraft } from "./draft"
import { dayRange, dragMove, dragRange, dragResize, pointerToDay, pointerToSlot, tapRange, type Slot } from "./timeMath"
import { dragPreview, pressTarget, useDrop, useGridPointer, type GridActions } from "./useGridPointer"

const HOUR_REM = 3
const GUTTER = "3.75rem"
const NARROW_GUTTER = "3rem"
const LANE_REM = 1.375
// Collapsed, the all-day row shows two rows and "+N more". Expanded, it scrolls past six.
const ALL_DAY_ROWS = 3
const EMPTY_ROW_REM = 1
const START_HOUR = 8
// Indents stop at three, so a deep stack keeps a readable width
const MAX_INDENTS = 3

/** Left and width of a laid out block inside its day column, after its indents */
function blockBox(block: { depth: number; left: number; width: number }) {
  const indent = `${Math.min(block.depth, MAX_INDENTS)} * max(25%, 1.5rem)`
  return {
    left: `calc(${indent} + (100% - ${indent}) * ${block.left} + 0.0625rem)`,
    width: `calc((100% - ${indent}) * ${block.width} - 0.125rem)`,
  }
}

/** Where a bar sits in the all-day row, inset from the column edges where it does not run on */
function allDayBarStyle(
  lane: number,
  bar: { start: number; span: number; continuesBefore: boolean; continuesAfter: boolean },
  count: number,
) {
  const before = bar.continuesBefore ? 0.0625 : 0.1875
  return {
    top: `${0.1875 + lane * LANE_REM}rem`,
    left: `calc(${(bar.start / count) * 100}% + ${before}rem)`,
    width: `calc(${(bar.span / count) * 100}% - ${before + (bar.continuesAfter ? 0 : 0.25)}rem)`,
  }
}

const remOf = (axisMinutes: number) => `${(axisMinutes * HOUR_REM) / 60}rem`

// Locale time on full hours, "09:00" or "9 AM"
function hourLabel(at: Date): string {
  return formatTime(at).replace(/:00(?=\s?[AaPp])/, "")
}

const draftPositioned = (draft: Pick<EventDraft, "start" | "end" | "allDay">): Positioned => draftTimes(draft)

/**
 * The time grid for one or more days, Google style: day headers, an all-day row of packed bars, then
 * the hours. Block edges and the Now line go through the shared axis, so 09:00 lines up on every day,
 * and the repeated hour of a 25-hour day gets its own row. Empty time creates, events move and resize.
 */
export function WeekGrid({
  days,
  items,
  narrow = false,
  label,
  onOpen,
  onShowDay,
  draft = null,
  dismissing = false,
  canMove,
  onCreate,
  onChangeTimes,
  onNudge,
  reveal = 0,
}: {
  days: Date[]
  items: CalendarItem[]
  narrow?: boolean
  label: string
  onOpen?: OpenItem
  onShowDay?: (day: Date) => void
} & GridActions) {
  const now = useNow()
  const scroller = useRef<HTMLDivElement>(null)
  const header = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const allDayArea = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const daysKey = days.map(dayKey).join(",")
  // eslint-disable-next-line react-hooks/exhaustive-deps -- days is keyed by its dates, so a new array of the same days keeps the memo
  const axis = useMemo(() => timeAxis(days), [daysKey])
  const columns = `${narrow ? NARROW_GUTTER : GUTTER} repeat(${days.length}, minmax(0, 1fr))`
  const todayIndex = days.findIndex((day) => sameDay(day, now))
  const byKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items])

  // eslint-disable-next-line react-hooks/exhaustive-deps -- days is keyed by its dates, so a new array of the same days keeps the memo
  const allDay = useMemo(() => packAllDay(items, days, expanded ? Infinity : ALL_DAY_ROWS), [items, daysKey, expanded])
  const overflowing = allDay.overflow.size > 0
  const allDayLanes = allDay.rows.length + (overflowing ? 1 : 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- days is keyed by its dates, so a new array of the same days keeps the memo
  const blocks = useMemo(() => days.map((day) => layoutDay(items, day)), [items, daysKey])
  const { held, drop } = useDrop(onChangeTimes)

  const timedSlot = useCallback(
    (x: number, y: number): Slot | null => {
      const node = body.current
      if (!node) return null
      const rect = node.getBoundingClientRect()
      const dayIndex = pointerToDay(x, rect.left, rect.width, days.length)
      return pointerToSlot(y, dayIndex, { axis, top: rect.top, minuteHeight: rect.height / axis.minutes })
    },
    [axis, days.length],
  )

  const daySlot = useCallback(
    (x: number): Slot | null => {
      const node = allDayArea.current
      if (!node) return null
      const rect = node.getBoundingClientRect()
      const dayIndex = pointerToDay(x, rect.left, rect.width, days.length)
      return { dayIndex, minutes: 0, at: days[dayIndex] }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- days is keyed by its dates, so a new array of the same days keeps the memo
    [daysKey],
  )

  const timed = useGridPointer<CalendarItem>({
    slotAt: timedSlot,
    scroller,
    topEdge: () => header.current?.getBoundingClientRect().bottom ?? 0,
    dismissing,
    onTap: (slot) => onCreate?.(tapRange(slot), false),
    onSelect: (from, to) => onCreate?.(dragRange(from, to), false),
    onDrop: (target, from, to) =>
      drop(target.item, target.kind === "move" ? dragMove(target.item, from, to) : dragResize(target.item, from, to)),
  })

  const bars = useGridPointer<CalendarItem>({
    slotAt: (x) => daySlot(x),
    scroller,
    autoscroll: false,
    dismissing,
    onTap: (slot) => onCreate?.({ start: slot.at, end: slot.at }, true),
    onSelect: (from, to) => onCreate?.(dayRange(from, to), true),
    onDrop: (target, from, to) => drop(target.item, dragMove(target.item, from, to)),
  })

  // A new draft, a drag on empty time, or an event moved to a new spot. One dragged in the time grid
  // stays in the columns while it is dragged, even when a resize takes it past 24 hours.
  const timedDrag = dragPreview(timed.drag)
  const preview = timedDrag ?? dragPreview(bars.drag) ?? held
  const inColumns = (item: CalendarItem) => item === timedDrag || !inAllDayRow(item)
  const ghost: (Pick<EventDraft, "start" | "end" | "allDay"> & { title: string; type: EventDraft["type"]; anchor: boolean }) | null =
    timed.drag?.target.kind === "empty"
      ? { ...dragRange(timed.drag.from, timed.drag.to), allDay: false, title: NO_TITLE, type: "event", anchor: false }
      : bars.drag?.target.kind === "empty"
        ? { ...dayRange(bars.drag.from, bars.drag.to), allDay: true, title: NO_TITLE, type: "event", anchor: false }
        : draft && !draft.event
          ? { ...draft, title: draftTitle(draft), anchor: true }
          : null

  const ghostBars = useMemo(() => {
    const placed: {
      title: string
      item?: CalendarItem
      type?: EventDraft["type"]
      anchor: boolean
      bar: ReturnType<typeof packAllDay>["rows"][number][number]
    }[] = []
    if (ghost?.allDay) {
      for (const bar of packAllDay([draftPositioned(ghost)], days).rows.flat())
        placed.push({ title: ghost.title, type: ghost.type, anchor: ghost.anchor, bar })
    }
    if (preview && !inColumns(preview)) {
      for (const bar of packAllDay([preview], days).rows.flat())
        placed.push({ title: itemTitle(preview), item: preview, anchor: false, bar })
    }
    return placed
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ghost is rebuilt each render, so the memo keys on its fields and the days
  }, [ghost?.allDay, ghost?.start.getTime(), ghost?.end.getTime(), ghost?.title, ghost?.type, ghost?.anchor, preview, daysKey])

  const ghostBlocks = useMemo(() => {
    const timedGhost = ghost && !ghost.allDay ? draftPositioned(ghost) : null
    const timedPreview = preview && inColumns(preview) ? preview : null
    return days.map((day) => [
      ...(timedGhost ? layoutDay([timedGhost], day, true).map((block) => ({ block, item: undefined })) : []),
      ...(timedPreview ? layoutDay([timedPreview], day, true).map((block) => ({ block, item: timedPreview })) : []),
    ])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ghost is rebuilt each render, so the memo keys on its fields and the days
  }, [ghost?.allDay, ghost?.start.getTime(), ghost?.end.getTime(), preview, daysKey])

  const lanes = allDayLanes + (ghostBars.length ? 1 : 0)
  const draggingKey = preview?.key

  // Opens on working hours, or an hour before now when today is shown, with a labelled hour at the top
  // even when the end of the day caps the scroll. Scroll anchoring is off, so the all-day row growing
  // as events load does not shift it. Later navigation keeps the scroll.
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    const rem = remPx()
    const hourPx = HOUR_REM * rem
    const at = todayIndex >= 0 ? axis.toAxis(todayIndex, Math.max(0, minutesOfDay(now) - 60)) : axis.toAxis(0, START_HOUR * 60)
    const capped = Math.min((at / 60) * hourPx, node.scrollHeight - node.clientHeight)
    // Half a rem of the hour before stays in view, so the top label is not cut by the header
    node.scrollTop = Math.max(0, Math.floor(capped / hourPx) * hourPx - rem / 2)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on mount only, later navigation keeps the scroll
  }, [])

  // A draft from Create or C is brought to the upper third of the grid, so its popover opens beside it
  // and not in a corner. Other drafts only scroll when a time change takes them out of sight.
  const draftKey = draft && !draft.event ? `${draft.start.getTime()}|${draft.end.getTime()}|${draft.allDay}` : ""
  const revealed = useRef(reveal)
  useLayoutEffect(() => {
    const node = scroller.current
    const ghostNode = node?.querySelector("[data-calendar-ghost]")
    const fresh = reveal !== revealed.current
    revealed.current = reveal
    if (!node || !ghostNode || !draftKey) return
    const rem = remPx()
    const box = ghostNode.getBoundingClientRect()
    const top = header.current?.getBoundingClientRect().bottom ?? node.getBoundingClientRect().top
    const bottom = node.getBoundingClientRect().bottom
    if (fresh) node.scrollTop += box.top - (top + (bottom - top) * 0.3)
    else if (box.top < top) node.scrollTop -= top - box.top + rem
    else if (box.bottom > bottom) node.scrollTop += Math.min(box.bottom - bottom + rem, box.top - top - rem)
  }, [draftKey, reveal])

  const movable = (item: CalendarItem) => {
    const can = !!canMove?.(item)
    return { draggable: can, dragging: item.key === draggingKey, onNudge: can ? onNudge : undefined }
  }

  const press = (pointer: typeof timed) => (event: ReactPointerEvent) => {
    const target = pressTarget(event, byKey)
    if (target) pointer.start(event, target)
  }

  return (
    <div
      ref={scroller}
      role="group"
      aria-label={label}
      className="relative min-h-0 flex-1 overflow-y-auto select-none [overflow-anchor:none] [scrollbar-gutter:stable]"
    >
      <div ref={header} className="sticky top-0 z-30 border-b-[0.0625rem] border-border bg-card">
        <div className="grid" style={{ gridTemplateColumns: columns }}>
          <span aria-hidden="true" />
          {days.map((day, index) => {
            const isToday = index === todayIndex
            return (
              <div
                key={day.getTime()}
                className={cn("flex flex-col gap-0.5 pt-2 pb-1.5", days.length === 1 ? "items-start pl-3" : "items-center")}
              >
                <span aria-hidden="true" className={cn("text-micro font-medium", isToday ? "text-foreground" : "text-muted-foreground")}>
                  {formatWeekdayShort(day)}
                </span>
                <button
                  type="button"
                  aria-label={`Day view for ${formatDayTitle(day)}${isToday ? ", today" : ""}`}
                  aria-current={isToday ? "date" : undefined}
                  onClick={() => onShowDay?.(day)}
                  className={cn(
                    "flex size-[2.4rem] items-center justify-center rounded-full text-title font-semibold tabular-nums transition-colors duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
                    isToday ? "bg-app-sky text-app-sky-ink" : "text-foreground hover:bg-app-hover",
                  )}
                >
                  {day.getDate()}
                </button>
              </div>
            )
          })}
        </div>

        <div
          role="group"
          aria-label="All-day events"
          className={cn("grid", expanded && "max-h-[9rem] overflow-y-auto")}
          style={{ gridTemplateColumns: columns }}
        >
          <div className="flex items-start justify-end pt-1 pr-1.5">
            {(overflowing || expanded) && (
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? "Show fewer all-day events" : "Show all all-day events"}
                onClick={() => setExpanded((open) => !open)}
                className="flex size-[1.5rem] items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
              >
                <ChevronDown aria-hidden="true" weight="bold" className={cn("motion-rotate size-[0.8rem]", expanded && "rotate-180")} />
              </button>
            )}
          </div>
          <div
            ref={allDayArea}
            onPointerDown={press(bars)}
            data-open=""
            className="motion-size relative overflow-clip [overflow-clip-margin:0.4rem]"
            style={{ gridColumn: `2 / span ${days.length}`, height: `${lanes ? lanes * LANE_REM + 0.375 : EMPTY_ROW_REM}rem` }}
          >
            {/* An empty row stays slim, and reaches into the space under the dates so it is easy to press */}
            <div aria-hidden="true" className="absolute inset-x-0 -top-[0.4rem] h-[0.4rem]" />
            <div
              aria-hidden="true"
              className="absolute inset-0 grid"
              style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
            >
              {days.map((day) => (
                <span key={day.getTime()} className="border-l-[0.0625rem] border-border" />
              ))}
            </div>
            {allDay.rows.flatMap((row, lane) =>
              row.map((bar) => (
                <EventBar
                  key={bar.event.key}
                  item={bar.event}
                  now={now}
                  continuesBefore={bar.continuesBefore}
                  continuesAfter={bar.continuesAfter}
                  onOpen={onOpen}
                  {...movable(bar.event)}
                  className="absolute"
                  style={allDayBarStyle(lane, bar, days.length)}
                />
              )),
            )}
            {days.map((day, index) => {
              const more = allDay.overflow.get(dayKey(day))
              if (!more) return null
              return (
                <button
                  key={day.getTime()}
                  type="button"
                  aria-label={`${more} more all-day ${more === 1 ? "event" : "events"} on ${formatDayTitle(day)}`}
                  onClick={() => setExpanded(true)}
                  className="absolute flex h-[1.25rem] items-center rounded-md px-1.5 text-caption font-medium text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
                  style={{
                    top: `${0.1875 + allDay.rows.length * LANE_REM}rem`,
                    left: `calc(${(index / days.length) * 100}% + 0.1875rem)`,
                    maxWidth: `calc(${100 / days.length}% - 0.375rem)`,
                  }}
                >
                  +{more} more
                </button>
              )
            })}
            {ghostBars.map(({ title, item, type, anchor, bar }) => (
              <GhostBlock
                key={`${item?.key ?? "draft"}|${bar.start}`}
                bar
                anchor={anchor}
                title={title}
                item={item}
                type={type}
                continuesBefore={bar.continuesBefore}
                continuesAfter={bar.continuesAfter}
                style={allDayBarStyle(allDayLanes, bar, days.length)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: columns }}>
        <div aria-hidden="true" className="relative" style={{ height: remOf(axis.minutes) }}>
          {axis.rows.map((row, index) =>
            index === 0 ? null : (
              <span
                key={index}
                className="absolute right-[0.5rem] -translate-y-1/2 text-micro font-medium whitespace-nowrap text-muted-foreground tabular-nums"
                style={{ top: remOf(index * 60) }}
              >
                {hourLabel(row.at)}
              </span>
            ),
          )}
        </div>

        <div
          ref={body}
          onPointerDown={press(timed)}
          className="relative"
          style={{ gridColumn: `2 / span ${days.length}`, height: remOf(axis.minutes) }}
        >
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            {axis.rows.map((row, index) =>
              index === 0 ? null : (
                <span key={index} className="absolute inset-x-0 border-t-[0.0625rem] border-border" style={{ top: remOf(index * 60) }} />
              ),
            )}
          </div>
          <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((day, dayIndex) => {
              const dayEnd = addDays(day, 1).getTime()
              return (
                <div
                  key={day.getTime()}
                  role="group"
                  aria-label={formatDayTitle(day)}
                  className="relative border-l-[0.0625rem] border-border"
                >
                  <div className={cn("absolute inset-y-0 left-0", narrow ? "right-[0.25rem]" : "right-[0.5rem]")}>
                    {blocks[dayIndex].map((block) => {
                      const top = axis.toAxis(dayIndex, block.top)
                      const bottom = axis.toAxis(dayIndex, block.top + block.height)
                      return (
                        <EventBlock
                          key={block.event.key}
                          item={block.event}
                          minutes={bottom - top}
                          now={now}
                          onOpen={onOpen}
                          resizable={block.end.getTime() <= dayEnd}
                          stacked={block.depth > 0 || block.col > 0}
                          {...movable(block.event)}
                          style={{ top: remOf(top), height: `calc(${remOf(bottom - top)} - 0.125rem)`, ...blockBox(block) }}
                        />
                      )
                    })}
                    {ghostBlocks[dayIndex].map(({ block, item }, index) => {
                      const top = axis.toAxis(dayIndex, block.top)
                      const bottom = axis.toAxis(dayIndex, block.top + block.height)
                      return (
                        <GhostBlock
                          key={`${item?.key ?? "draft"}|${index}`}
                          item={item}
                          type={ghost?.type}
                          anchor={!item && !!ghost?.anchor && index === 0}
                          title={item ? itemTitle(item) : (ghost?.title ?? "")}
                          time={itemTimeText(item ?? block.event)}
                          start={block.start}
                          minutes={bottom - top}
                          style={{
                            top: remOf(top),
                            height: `calc(${remOf(bottom - top)} - 0.125rem)`,
                            left: "0.0625rem",
                            width: "calc(100% - 0.125rem)",
                          }}
                        />
                      )
                    })}
                  </div>
                  {dayIndex === todayIndex && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 z-20 h-[0.125rem] -translate-y-1/2 bg-app-berry forced-color-adjust-none forced-colors:bg-[Highlight]"
                      style={{ top: remOf(axis.toAxis(dayIndex, minutesOfDay(now))) }}
                    >
                      <span className="absolute top-1/2 -left-[0.375rem] size-[0.75rem] -translate-y-1/2 rounded-full bg-app-berry forced-color-adjust-none forced-colors:bg-[Highlight]" />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
