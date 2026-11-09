import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { ChevronLeft, ChevronRight } from "@/components/icons"
import {
  addDays,
  addMonths,
  dayKey,
  formatDayTitle,
  formatMonthTitle,
  formatWeekdayShort,
  sameDay,
  startOfDay,
  startOfMonth,
} from "@/lib/dates"
import { cn } from "@/lib/utils"

const ARROW_STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }

const NAV_BUTTON =
  "flex size-[1.5rem] items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring max-lg:size-11"

function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7
}

function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

/**
 * A month grid with Monday first, moved by arrow keys, Home, End, Page Up and Page Down. It keeps its
 * own month unless `month` is given, then it shows that month and asks `onMonthChange` to move.
 * `dots` marks days by "YYYY-MM-DD", and `rangeStart` to `rangeEnd` is shaded, such as the visible week.
 */
export function MiniMonth({
  value,
  onSelect,
  today = new Date(),
  month: controlledMonth,
  onMonthChange,
  dots,
  rangeStart,
  rangeEnd,
  className,
}: {
  value: Date | null
  onSelect: (day: Date) => void
  today?: Date
  month?: Date
  onMonthChange?: (month: Date) => void
  dots?: Set<string>
  rangeStart?: Date | null
  rangeEnd?: Date | null
  className?: string
}) {
  const titleId = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  const moved = useRef(false)
  const [focused, setFocused] = useState(() => startOfDay(value ?? today))
  // A controlled month moved from outside takes the focus along, onto the selected day or today when shown
  if (controlledMonth && !sameMonth(focused, controlledMonth)) {
    const inMonth = [value, today].find((day): day is Date => !!day && sameMonth(day, controlledMonth))
    setFocused(startOfDay(inMonth ?? startOfMonth(controlledMonth)))
  }
  const month = startOfMonth(controlledMonth ?? focused)
  const from = rangeStart ? startOfDay(rangeStart).getTime() : null
  const to = rangeEnd ? startOfDay(rangeEnd).getTime() : from
  const start = addDays(month, -weekdayIndex(month))
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)))

  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus()
  }, [focused])

  const show = (day: Date) => {
    setFocused(day)
    if (controlledMonth && !sameMonth(day, controlledMonth)) onMonthChange?.(startOfMonth(day))
  }

  const moveTo = (day: Date) => {
    moved.current = true
    show(day)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = ARROW_STEP[e.key]
    let next: Date | null = null
    if (step !== undefined) next = addDays(focused, step)
    else if (e.key === "Home") next = addDays(focused, -weekdayIndex(focused))
    else if (e.key === "End") next = addDays(focused, 6 - weekdayIndex(focused))
    else if (e.key === "PageUp") next = addMonths(focused, -1)
    else if (e.key === "PageDown") next = addMonths(focused, 1)
    if (!next) return
    e.preventDefault()
    moveTo(next)
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center justify-between gap-2 pl-1.5">
        <span id={titleId} aria-live="polite" className="text-body font-semibold text-foreground">
          {formatMonthTitle(month, today)}
        </span>
        <span className="flex items-center gap-0.5">
          <button type="button" aria-label="Previous month" onClick={() => show(addMonths(focused, -1))} className={NAV_BUTTON}>
            <ChevronLeft aria-hidden="true" weight="bold" className="size-[0.8rem]" />
          </button>
          <button type="button" aria-label="Next month" onClick={() => show(addMonths(focused, 1))} className={NAV_BUTTON}>
            <ChevronRight aria-hidden="true" weight="bold" className="size-[0.8rem]" />
          </button>
        </span>
      </div>
      <div ref={gridRef} role="grid" aria-labelledby={titleId} onKeyDown={onKeyDown} className="flex flex-col gap-0.5">
        <div role="row" className="grid grid-cols-7">
          {weeks[0].map((day) => (
            <span
              key={day.getTime()}
              role="columnheader"
              aria-label={formatWeekdayShort(day)}
              className="py-1 text-center text-micro font-medium text-muted-foreground"
            >
              {formatWeekdayShort(day).slice(0, 2)}
            </span>
          ))}
        </div>
        {weeks.map((week) => {
          // The days of the range in this week, edged once with more contrast or in high contrast rather than one edge per day
          const run = week.flatMap((day, index) =>
            from !== null && to !== null && day.getTime() >= from && day.getTime() <= to ? [index] : [],
          )
          return (
            <div key={week[0].getTime()} role="row" className={cn("relative grid grid-cols-7", from === null ? "gap-0.5" : "gap-y-0.5")}>
              {week.map((day, index) => {
                const selected = value !== null && sameDay(day, value)
                const isToday = sameDay(day, today)
                const outside = day.getMonth() !== month.getMonth()
                const time = day.getTime()
                const inRange = from !== null && to !== null && time >= from && time <= to
                const rangeFirst = inRange && (time === from || index === 0)
                const rangeLast = inRange && (time === to || index === 6)
                const dotted = dots?.has(dayKey(day)) ?? false
                const cell = (
                  <button
                    key={time}
                    type="button"
                    role="gridcell"
                    aria-selected={selected}
                    aria-current={isToday ? "date" : undefined}
                    aria-label={dotted ? `${formatDayTitle(day)}, has events` : formatDayTitle(day)}
                    tabIndex={sameDay(day, focused) ? 0 : -1}
                    onClick={() => onSelect(day)}
                    className={cn(
                      "relative flex h-[1.9rem] w-full items-center justify-center rounded-md text-ui font-medium tabular-nums transition-colors duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:h-11",
                      selected
                        ? "bg-app-sky text-app-sky-ink"
                        : cn(
                            "hover:bg-app-hover",
                            isToday ? "text-app-accent-text" : outside ? "text-muted-foreground" : "text-foreground",
                          ),
                    )}
                  >
                    {day.getDate()}
                    {dotted && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute bottom-[0.2rem] left-1/2 size-[0.25rem] -translate-x-1/2 rounded-full forced-color-adjust-none forced-colors:bg-[CanvasText]",
                          selected ? "bg-app-sky-ink" : "bg-app-sky-strong",
                        )}
                      />
                    )}
                  </button>
                )
                if (from === null) return cell
                return (
                  <span
                    key={time}
                    data-range={inRange ? "" : undefined}
                    className={cn("flex", inRange && "bg-app-selected", rangeFirst && "rounded-l-md", rangeLast && "rounded-r-md")}
                  >
                    {cell}
                  </span>
                )
              })}
              {run.length > 0 && (
                <span
                  aria-hidden="true"
                  style={{ left: `${(run[0] / 7) * 100}%`, width: `${(run.length / 7) * 100}%` }}
                  className="pointer-events-none absolute inset-y-0 hidden rounded-md border-[0.0625rem] border-app-text contrast-more:block forced-colors:block forced-colors:border-[Highlight]"
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
