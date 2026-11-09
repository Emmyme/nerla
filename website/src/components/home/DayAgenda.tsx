import { useId, useMemo, useState, type ReactNode } from "react"
import { Link } from "react-router"
import { ChevronDown, ChevronLeft, ChevronRight } from "@/components/icons"
import { Skeleton } from "@/components/ui/skeleton"
import type { CalendarEvent } from "@/lib/api/calendar"
import { useCalendarRange } from "@/lib/calendarStore"
import { MARK_RING } from "@/components/calendar/EventBlock"
import { itemTimeText, joinOpen } from "@/components/calendar/items"
import { TypeGlyph } from "@/components/calendar/TypeGlyph"
import {
  addDays,
  formatDayTitle,
  formatMonthTitle,
  formatShortDate,
  formatStartsIn,
  formatTime,
  formatWeekdayShort,
  sameDay,
  startOfDay,
  startOfWeek,
} from "@/lib/dates"
import { EVENT_FILL, EVENT_PAST, eventTone, eventTypeLabel, type EventTone } from "@/lib/eventColors"
import { eventRoom, openMeetingWindow } from "@/lib/meetingWindow"
import { useTypeShapes } from "@/lib/typeShapes"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { eventsByDay, hasEnded, isRunning, nowLineIndex, type DayEntry } from "./agendaTimeline"

const EVENT_DOT: Record<EventTone, string> = {
  sky: "bg-app-sky-strong",
  lavender: "bg-app-lavender-strong",
  pistachio: "bg-app-pistachio-strong",
  bubblegum: "bg-app-bubblegum",
  lemon: "bg-app-lemon",
  away: "bg-app-sunk ring-[0.0625rem] ring-inset ring-app-berry",
}

const QUIET_BUTTON =
  "flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-caption font-medium text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring max-lg:min-h-11"
const COMPACT_COUNT = 3
const NAV_BUTTON =
  "flex size-[1.5rem] items-center justify-center rounded-md bg-app-sunk text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring max-lg:size-11"

const EMPTY: CalendarEvent[] = []

type EventRangeStatus = "loading" | "ready" | "error"

type AgendaItem = DayEntry<CalendarEvent> & { tone: EventTone }

// The shared calendar store caches whole weeks, so Home and the calendar page share one fetch
function useEventRange(from: Date, days: number) {
  const fromTime = startOfDay(from).getTime()
  const range = useCalendarRange(new Date(fromTime), addDays(new Date(fromTime), days))
  const status: EventRangeStatus = range.status
  return { events: range.events, status, reload: () => void range.reload() }
}

type AgendaWeek = ReturnType<typeof useAgendaWeek>

// The week shown in the agenda, plus the latest known events of today for the page summary
export function useAgendaWeek(now: Date) {
  const today = startOfDay(now)
  const todayTime = today.getTime()
  const [picked, setPicked] = useState<Date | null>(null)
  const [todayCache, setTodayCache] = useState<{ day: number; events: CalendarEvent[] } | null>(null)
  const selected = picked ?? today
  const weekStart = startOfWeek(selected)
  const range = useEventRange(weekStart, 8)

  const covers = weekStart.getTime() <= todayTime && todayTime < addDays(weekStart, 8).getTime()
  if (covers && range.status === "ready" && (todayCache?.day !== todayTime || todayCache.events !== range.events)) {
    setTodayCache({ day: todayTime, events: range.events })
  }
  const todayEvents = todayCache?.day === todayTime ? todayCache.events : null
  const todayStatus: EventRangeStatus = todayEvents ? "ready" : covers && range.status === "loading" ? "loading" : "error"

  return {
    ...range,
    today,
    selected,
    weekStart,
    select: (day: Date | null) => setPicked(day && !sameDay(day, today) ? day : null),
    todayEvents: todayEvents ?? EMPTY,
    todayStatus,
  }
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

function tomorrowText(items: AgendaItem[]): string {
  if (items.length === 0) return "Nothing tomorrow"
  const first = items.find((item) => !item.event.all_day && item.index === 0)
  if (!first) return `Tomorrow: ${plural(items.length, "event")}${items.every((item) => item.event.all_day) ? ", all day" : ""}`
  const time = formatTime(first.start)
  return items.length === 1 ? `Tomorrow: 1 event at ${time}` : `Tomorrow: ${plural(items.length, "event")}, first at ${time}`
}

// Compact keeps the stacked phone agenda short: the running or next event plus two more
export function DayAgenda({ now, agenda, compact = false }: { now: Date; agenda: AgendaWeek; compact?: boolean }) {
  const headingId = useId()
  const { today, selected, weekStart, events, status, reload, select } = agenda
  const thisWeek = sameDay(weekStart, startOfWeek(today))
  const twelveHour = formatTime(new Date(2026, 0, 1, 13)).length > 5

  // The shown week plus the next Monday, which Sunday's tomorrow line reads
  const weekTime = weekStart.getTime()
  const byDay = useMemo(() => {
    const days = new Map<number, AgendaItem[]>()
    const within = { first: new Date(weekTime), last: addDays(new Date(weekTime), 7) }
    for (const [day, entries] of eventsByDay(events, within))
      days.set(
        day,
        entries.map((entry) => ({ ...entry, tone: eventTone(entry.event.event_type) })),
      )
    return days
  }, [events, weekTime])

  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const items = byDay.get(selected.getTime()) ?? []
  const isToday = sameDay(selected, today)

  return (
    <section aria-labelledby={headingId} className="rounded-xl bg-card px-4 pt-4 pb-4 text-foreground ring-[0.0625rem] ring-border">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-lead font-semibold tracking-normal">
          <span className="sr-only">Agenda, </span>
          {formatMonthTitle(selected, now)}
        </h2>
        <div className="flex items-center gap-1">
          {!thisWeek && (
            <button
              type="button"
              onClick={() => select(null)}
              className="h-[1.5rem] rounded-md bg-app-sunk px-2 text-caption font-medium text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:h-11 max-lg:px-3.5"
            >
              Today
            </button>
          )}
          <button type="button" aria-label="Previous week" onClick={() => select(addDays(selected, -7))} className={NAV_BUTTON}>
            <ChevronLeft aria-hidden="true" weight="bold" className="size-[0.8rem]" />
          </button>
          <button type="button" aria-label="Next week" onClick={() => select(addDays(selected, 7))} className={NAV_BUTTON}>
            <ChevronRight aria-hidden="true" weight="bold" className="size-[0.8rem]" />
          </button>
        </div>
      </div>

      <div role="group" aria-label={`Week of ${formatDayTitle(weekStart)}`} className="mb-3.5 grid grid-cols-7 gap-0.5">
        {week.map((day) => {
          const dayItems = byDay.get(day.getTime()) ?? []
          const isSelected = sameDay(day, selected)
          const dayIsToday = sameDay(day, today)
          const count = dayItems.length > 0 ? `, ${plural(dayItems.length, "event")}` : ""
          return (
            <button
              key={day.getTime()}
              type="button"
              aria-pressed={isSelected}
              aria-current={dayIsToday ? "date" : undefined}
              aria-label={`${formatDayTitle(day)}${count}`}
              onClick={() => select(day)}
              className={cn(
                "flex min-w-0 flex-col items-center gap-0.5 rounded-md pt-1 pb-1.5 transition-colors duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11",
                isSelected ? "bg-app-sky text-app-sky-ink" : "text-foreground hover:bg-app-hover",
              )}
            >
              <span className={cn("text-micro font-medium", !isSelected && "text-muted-foreground")}>{formatWeekdayShort(day)}</span>
              <span className={cn("text-body font-semibold tabular-nums", dayIsToday && !isSelected && "text-app-accent-text")}>
                {day.getDate()}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "size-[0.3rem] rounded-full",
                  dayItems.length === 0 ? "bg-transparent" : isSelected ? "bg-current" : cn(EVENT_DOT[dayItems[0].tone], MARK_RING),
                )}
              />
            </button>
          )
        })}
      </div>

      {status === "loading" ? (
        <div aria-hidden="true" className="flex flex-col gap-2">
          <Skeleton className="h-[3.4rem] rounded-lg" />
          <Skeleton className="h-[3.4rem] rounded-lg" />
        </div>
      ) : status === "error" ? (
        <Notice>
          Couldn't load events.{" "}
          <button
            type="button"
            onClick={reload}
            className="rounded-sm font-medium text-foreground underline-offset-[0.2rem] hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
          >
            Try again
          </button>
        </Notice>
      ) : items.length === 0 ? (
        <Notice>
          No events.{" "}
          <Link
            to="/calendar"
            className="rounded-sm font-medium text-foreground underline-offset-[0.2rem] hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
          >
            New event
          </Link>
        </Notice>
      ) : (
        <AgendaList
          key={selected.getTime()}
          label={`Agenda for ${formatDayTitle(selected)}`}
          items={items}
          now={now}
          isToday={isToday}
          compact={compact}
          twelveHour={twelveHour}
        />
      )}

      {isToday && status === "ready" && (
        <p className="mt-3.5 border-t-[0.0625rem] border-border pt-3 text-ui text-muted-foreground">
          {tomorrowText(byDay.get(addDays(today, 1).getTime()) ?? [])}
        </p>
      )}
    </section>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-app-sunk px-3 py-3.5 text-center text-ui text-muted-foreground">{children}</p>
}

function AgendaList({
  label,
  items,
  now,
  isToday,
  compact,
  twelveHour,
}: {
  label: string
  items: AgendaItem[]
  now: Date
  isToday: boolean
  compact: boolean
  twelveHour: boolean
}) {
  const [showEarlier, setShowEarlier] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const ended = isToday ? items.filter((item) => hasEnded(item, now)) : []
  const upcoming = isToday ? items.filter((item) => !hasEnded(item, now)) : items
  const visible = compact && isToday && !showAll ? upcoming.slice(0, COMPACT_COUNT) : upcoming
  const list = items.filter((item) => visible.includes(item) || (showEarlier && ended.includes(item)))
  const nowAt = isToday ? nowLineIndex(list, now) : -1
  const hidden = upcoming.length - visible.length
  const columns = twelveHour ? "grid-cols-[3.6rem_minmax(0,1fr)]" : "grid-cols-[2.6rem_minmax(0,1fr)]"

  return (
    <ol aria-label={label} className="flex flex-col gap-2">
      {ended.length > 0 && (
        <li className={cn("grid gap-x-2", columns)}>
          <span aria-hidden="true" />
          <button
            type="button"
            aria-expanded={showEarlier}
            onClick={() => setShowEarlier((open) => !open)}
            className={cn(QUIET_BUTTON, "-my-0.5 justify-self-start")}
          >
            <ChevronDown aria-hidden="true" weight="bold" className={cn("motion-rotate size-[0.7rem]", !showEarlier && "-rotate-90")} />
            {ended.length} earlier<span className="sr-only"> {ended.length === 1 ? "event" : "events"}</span>
          </button>
        </li>
      )}
      {list.map((item, index) => (
        <AgendaRow
          key={item.event.occurrence_id}
          item={item}
          now={now}
          running={isToday && isRunning(item, now)}
          twelveHour={twelveHour}
          nowLine={index === nowAt}
          revealed={ended.includes(item) || (compact && isToday && !upcoming.slice(0, COMPACT_COUNT).includes(item))}
        />
      ))}
      {nowAt === list.length && <NowLine now={now} />}
      {hidden > 0 && (
        <li className={cn("grid gap-x-2", columns)}>
          <span aria-hidden="true" />
          <button
            type="button"
            onClick={() => {
              setShowAll(true)
              setShowEarlier(true)
            }}
            className={cn(QUIET_BUTTON, "-my-0.5 justify-self-start")}
          >
            Show full day<span className="sr-only">, {hidden} more</span>
          </button>
        </li>
      )}
    </ol>
  )
}

function NowLine({ now }: { now: Date }) {
  return (
    <li className="flex items-center gap-2 text-caption font-medium text-app-berry-text">
      <span className="whitespace-nowrap tabular-nums">Now {formatTime(now)}</span>
      <span
        aria-hidden="true"
        className="h-[0.125rem] flex-1 rounded-full bg-app-berry opacity-60 forced-color-adjust-none forced-colors:bg-[Highlight] forced-colors:opacity-100"
      />
    </li>
  )
}

// A day after the first of a timed event shows how long it still runs, and the gutter stays empty
function rowTimes(item: AgendaItem, now: Date, running: boolean): { gutter: string; time: string } {
  const { event, start, end, index, days } = item
  if (event.all_day) return { gutter: "", time: days > 1 ? `All day · day ${index + 1} of ${days}` : "All day" }
  const gutter = index === 0 ? formatTime(start) : ""
  if (running)
    return { gutter, time: `Now · until ${sameDay(end, now) ? formatTime(end) : `${formatShortDate(end, now)}, ${formatTime(end)}`}` }
  // The gutter holds the start, so the card only adds the end
  if (days === 1) return { gutter, time: item.hasEnd ? `Until ${formatTime(end)}` : "" }
  if (index === 0) return { gutter, time: itemTimeText(event) }
  return { gutter, time: index === days - 1 ? `Until ${formatTime(end)}` : "All day" }
}

function AgendaRow({
  item,
  now,
  running,
  twelveHour,
  nowLine,
  revealed,
}: {
  item: AgendaItem
  now: Date
  running: boolean
  twelveHour: boolean
  nowLine: boolean
  /** Shown by Earlier or Show full day, so it eases in */
  revealed: boolean
}) {
  const { event } = item
  const past = hasEnded(item, now)
  const declined = event.viewer_response === "no"
  const join = !declined && joinOpen(event, now)
  const { gutter, time } = rowTimes(item, now, running)
  const meta = [time, event.location].filter(Boolean).join(" · ")
  const spokenStart = !event.all_day && !running && item.days === 1 ? gutter : ""
  const shapes = useTypeShapes()

  return (
    <>
      {nowLine && <NowLine now={now} />}
      <li
        className={cn(
          "grid gap-x-2",
          twelveHour ? "grid-cols-[3.6rem_minmax(0,1fr)]" : "grid-cols-[2.6rem_minmax(0,1fr)]",
          revealed && "motion-panel animate-in fade-in-0 motion-safe:slide-in-from-top-1",
        )}
      >
        <span aria-hidden="true" className="pt-2.5 text-right text-caption whitespace-nowrap text-muted-foreground tabular-nums">
          {gutter}
        </span>
        <div className={cn("min-w-0 rounded-lg px-3 py-2.5", past ? EVENT_PAST[item.tone] : EVENT_FILL[item.tone])}>
          {/* The gutter is hidden from screen readers, so the start is read here */}
          {spokenStart && <span className="sr-only">{spokenStart}</span>}
          {meta && (
            <p
              title={meta}
              className={cn(
                "truncate text-caption font-medium tabular-nums",
                past ? "text-muted-foreground dark:text-current" : "opacity-80",
              )}
            >
              {meta}
            </p>
          )}
          <h3 className={cn("text-ui leading-[1.35] font-semibold tracking-normal", meta && "mt-0.5", declined && "line-through")}>
            {shapes && <TypeGlyph type={event.event_type} className="mr-1 inline size-[0.8rem] align-[-0.1rem]" />}
            {event.title}
          </h3>
          {/* The color says the type, so it is read out too */}
          <span className="sr-only">{eventTypeLabel(event.event_type)}</span>
          {join && (
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="text-caption font-medium tabular-nums">{item.start > now ? formatStartsIn(item.start, now) : ""}</span>
              <Button variant="join" size="sm" aria-label={`Join ${event.title}`} onClick={() => void openMeetingWindow(eventRoom(event))}>
                Join
              </Button>
            </div>
          )}
        </div>
      </li>
    </>
  )
}
