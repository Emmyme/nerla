import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import {
  addDays,
  dayKey,
  formatDayTitle,
  formatMonthTitle,
  formatShortDate,
  formatWeekdayShort,
  parseDueDate,
  sameDay,
  startOfDay,
  startOfWeek,
} from "@/lib/dates"
import type { EventType } from "@/lib/eventColors"
import { cn, remPx } from "@/lib/utils"
import { ItemMark, struck, type OpenItem } from "./EventBlock"
import { hasEnded, itemLabel, itemTitle, type CalendarItem, type TeamPerson } from "./items"
import { useCalendarItems } from "./useCalendarItems"
import { useNow } from "./useNow"
import { groupByDay, mergeLoaded, type Loaded } from "./viewMath"

const STEP_WEEKS = 8
const AUTO_STEPS = 2
const WATCH_BEFORE_WEEKS = 1
const WATCH_AFTER_WEEKS = 4
const VISIBLE_MARGIN_WEEKS = 1
const LOAD_MARGIN_REM = 25
const NO_TYPES: ReadonlySet<EventType> = new Set()

const weeks = (date: Date | number, count: number) => addDays(new Date(date), count * 7).getTime()
/**
 * A continuous agenda from the anchor day on. Only the weeks around the rows on screen are watched,
 * so reloads stay small. Weeks loaded earlier stay in a local copy. Later weeks load on their own a
 * couple of times, then through "Show more", and earlier weeks load when the user scrolls up.
 */
export function ScheduleView({
  anchor,
  hidden,
  people,
  label,
  onOpen,
  onShowDay,
}: {
  anchor: Date
  hidden: ReadonlySet<EventType>
  people: TeamPerson[]
  label: string
  onOpen?: OpenItem
  onShowDay?: (day: Date) => void
}) {
  const now = useNow()
  const scroller = useRef<HTMLDivElement>(null)
  const pin = useRef<{ key: string; offset: number } | null>(null)
  const ownScroll = useRef(false)
  const lastTop = useRef(0)
  const autoSteps = useRef(0)
  const anchorKey = dayKey(anchor)
  const shownAnchor = useRef(anchorKey)
  const holdTop = useRef(false)
  const [focus, setFocus] = useState(() => startOfWeek(anchor).getTime())
  const [lastWeek, setLastWeek] = useState(focus)
  const [loaded, setLoaded] = useState<Loaded<CalendarItem> | null>(null)
  const [pending, setPending] = useState<{ from: number; to: number } | null>(null)
  const [placed, setPlaced] = useState(false)

  const watchFrom = weeks(focus, -WATCH_BEFORE_WEEKS)
  const watchTo = Math.max(weeks(focus, WATCH_AFTER_WEEKS), weeks(lastWeek, VISIBLE_MARGIN_WEEKS + 1))
  const live = useCalendarItems(new Date(watchFrom), new Date(watchTo), { hidden: NO_TYPES, people })
  const extra = useCalendarItems(new Date(pending?.from ?? watchFrom), new Date(pending?.to ?? watchTo), { hidden: NO_TYPES, people })
  const failed = live.status === "error"
  const extraFailed = !!pending && extra.status === "error"

  const setScroll = (node: HTMLElement, top: number) => {
    if (Math.abs(node.scrollTop - top) < 1) return
    ownScroll.current = true
    node.scrollTop = top
  }

  // J and K inside the loaded weeks scroll there. Further away, the list starts over at the new day.
  useLayoutEffect(() => {
    if (shownAnchor.current === anchorKey) return
    shownAnchor.current = anchorKey
    const at = anchor.getTime()
    const node = scroller.current
    if (loaded && placed && node && at >= loaded.from && at < loaded.to) {
      const target = [...node.querySelectorAll<HTMLElement>("[data-day]")].find((el) => (el.dataset.day ?? "") >= anchorKey)
      if (target) setScroll(node, target.offsetTop)
      setFocus(startOfWeek(anchor).getTime())
      return
    }
    autoSteps.current = 0
    pin.current = null
    holdTop.current = false
    setLastWeek(startOfWeek(anchor).getTime())
    setLoaded(null)
    setPending(null)
    setPlaced(false)
    setFocus(startOfWeek(anchor).getTime())
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the anchor day changes, and reads the rest as it is then
  }, [anchorKey])

  useEffect(() => {
    if (live.status !== "ready") return
    setLoaded((shown) => mergeLoaded(shown, watchFrom, watchTo, live.items))
  }, [live.items, live.status, watchFrom, watchTo])

  useEffect(() => {
    if (!pending || extra.status !== "ready") return
    setLoaded((shown) => mergeLoaded(shown, pending.from, pending.to, extra.items))
    setPending(null)
  }, [extra.items, extra.status, pending])

  // A teammate taken off the list leaves the weeks that are no longer watched too
  const peopleKey = people.map((person) => person.id).join(",")
  useEffect(() => {
    const ids = new Set(peopleKey ? peopleKey.split(",") : [])
    setLoaded((shown) => shown && { ...shown, items: shown.items.filter((item) => !item.person || ids.has(item.person.id)) })
  }, [peopleKey])

  const today = startOfDay(now)
  const todayMs = today.getTime()
  const days = useMemo(() => {
    if (!loaded) return null
    const visible = loaded.items.filter((item) => item.person || item.entry.busy || !hidden.has(item.entry.event_type))
    return groupByDay(visible, new Date(loaded.from), new Date(loaded.to), new Date(todayMs))
  }, [loaded, hidden, todayMs])

  const extendAfter = useCallback(() => {
    if (!loaded || pending) return
    setPending({ from: loaded.to, to: weeks(loaded.to, STEP_WEEKS) })
  }, [loaded, pending])

  const extendBefore = useCallback(() => {
    if (!loaded || pending) return
    setPending({ from: weeks(loaded.from, -STEP_WEEKS), to: loaded.from })
  }, [loaded, pending])

  const autoExtend = useCallback(() => {
    if (autoSteps.current >= AUTO_STEPS || !loaded || pending) return false
    autoSteps.current += 1
    extendAfter()
    return true
  }, [loaded, pending, extendAfter])

  // The top row anchors the scroll, and the watched weeks run from it to past the last row on screen
  const remember = useCallback(() => {
    const node = scroller.current
    if (!node) return
    const top = node.getBoundingClientRect().top
    const bottom = top + node.clientHeight
    let first: HTMLElement | null = null
    let last: HTMLElement | null = null
    for (const el of node.querySelectorAll<HTMLElement>("[data-day]")) {
      const box = el.getBoundingClientRect()
      if (box.bottom <= top) continue
      if (box.top >= bottom) break
      first ??= el
      last = el
    }
    if (!first || !last) return
    pin.current = { key: first.dataset.day ?? "", offset: first.getBoundingClientRect().top - top }
    const firstDay = parseDueDate(first.dataset.day)
    const lastDay = parseDueDate(last.dataset.day)
    if (firstDay) setFocus(startOfWeek(firstDay).getTime())
    if (lastDay) setLastWeek(startOfWeek(lastDay).getTime())
  }, [])

  const nearEnd = (node: HTMLElement) => node.scrollHeight - node.scrollTop - node.clientHeight < LOAD_MARGIN_REM * remPx()

  // Opens on the anchor day, then keeps the top row in place as weeks come in above or below
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node || !days) return
    if (!placed) {
      if (pending && !extraFailed) return
      const target = [...node.querySelectorAll<HTMLElement>("[data-day]")].find((el) => (el.dataset.day ?? "") >= anchorKey)
      const goal = target ? target.offsetTop : node.scrollHeight
      if (node.scrollHeight - goal < node.clientHeight && autoExtend()) return
      setScroll(node, goal)
      lastTop.current = node.scrollTop
      setPlaced(true)
      remember()
      return
    }
    // "Show earlier" lets the new rows come into view instead of holding the old top row in place
    if (holdTop.current) {
      if (!pending || extraFailed) holdTop.current = false
    } else {
      const kept = pin.current && node.querySelector<HTMLElement>(`[data-day="${pin.current.key}"]`)
      if (kept && pin.current)
        setScroll(node, node.scrollTop + kept.getBoundingClientRect().top - node.getBoundingClientRect().top - pin.current.offset)
    }
    lastTop.current = node.scrollTop
    remember()
    if (nearEnd(node)) autoExtend()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the shown weeks change, the anchor and helpers are read as they are then
  }, [days, placed, pending, extraFailed])

  const onScroll = () => {
    const node = scroller.current
    if (!node) return
    remember()
    const top = node.scrollTop
    const programmatic = ownScroll.current
    ownScroll.current = false
    const up = top < lastTop.current
    lastTop.current = top
    if (programmatic || !placed) return
    if (up && top < LOAD_MARGIN_REM * remPx()) extendBefore()
    else if (!up && nearEnd(node)) autoExtend()
  }

  const months = new Set<string>()
  const linkButton =
    "rounded-sm font-medium text-foreground underline-offset-[0.2rem] hover:underline focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring disabled:text-muted-foreground disabled:no-underline"
  const showEarlier = () => {
    holdTop.current = true
    extendBefore()
  }
  const note = "flex flex-wrap items-center gap-x-2 px-4 text-ui text-muted-foreground sm:px-5"
  const extending = (later: boolean) => !!pending && !!loaded && (later ? pending.from >= loaded.to : pending.to <= loaded.from)
  const extensionError = (
    <span role="alert" className="text-app-berry-text">
      {extra.error}{" "}
      <button type="button" onClick={() => void extra.reload()} className={linkButton}>
        Try again
      </button>
    </span>
  )

  return (
    <div
      ref={scroller}
      role="region"
      aria-label={label}
      aria-busy={!days || !!pending}
      onScroll={onScroll}
      className="relative min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
    >
      {failed && (
        <p role="alert" className="sticky top-0 z-10 m-3 rounded-lg bg-app-sunk px-3.5 py-3 text-ui text-app-berry-text">
          {live.error}{" "}
          <button type="button" onClick={() => void live.reload()} className={linkButton}>
            Try again
          </button>
        </p>
      )}
      {!days ? (
        !failed && (
          <div aria-hidden="true" className="flex flex-col gap-3 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[2.75rem] rounded-lg" />
            ))}
          </div>
        )
      ) : (
        <>
          {loaded && (
            <p className={cn(note, "pt-3.5")}>
              {extending(false) ? (
                extraFailed ? (
                  extensionError
                ) : (
                  "Loading earlier events"
                )
              ) : (
                <>
                  Showing events from {formatShortDate(new Date(loaded.from), today)}
                  <button type="button" onClick={showEarlier} disabled={!!pending} className={linkButton}>
                    Show earlier
                  </button>
                </>
              )}
            </p>
          )}
          <ol className="flex flex-col">
            {days.map(({ day, key, rows }) => {
              const month = `${day.getFullYear()}-${day.getMonth()}`
              const newMonth = !months.has(month)
              months.add(month)
              const isToday = sameDay(day, today)
              return (
                <li key={key} data-day={key} className="flex flex-col">
                  {newMonth && (
                    <h2 className="px-4 pt-4 pb-1.5 text-lead font-semibold text-foreground sm:px-5">
                      {formatMonthTitle(day, new Date(0))}
                    </h2>
                  )}
                  <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-2 border-b-[0.0625rem] border-border px-3 py-2 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:px-4">
                    <h3 className="self-start">
                      <button
                        type="button"
                        aria-label={`Day view for ${formatDayTitle(day)}${isToday ? ", today" : ""}`}
                        aria-current={isToday ? "date" : undefined}
                        onClick={() => onShowDay?.(day)}
                        className="flex flex-col items-center gap-0.5 rounded-md p-0.5 text-left transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none sm:flex-row sm:gap-2"
                      >
                        <span
                          className={cn(
                            "flex size-[2rem] shrink-0 items-center justify-center rounded-full text-lead font-semibold tabular-nums",
                            isToday ? "bg-app-sky text-app-sky-ink" : "text-foreground",
                          )}
                        >
                          {day.getDate()}
                        </span>
                        <span
                          className={cn("text-micro font-medium max-sm:order-first", isToday ? "text-foreground" : "text-muted-foreground")}
                        >
                          {formatWeekdayShort(day)}
                        </span>
                      </button>
                    </h3>
                    {rows.length === 0 ? (
                      <p className="self-center py-1.5 text-ui text-muted-foreground">Nothing planned today</p>
                    ) : (
                      <ul aria-label={formatDayTitle(day)} className="flex min-w-0 flex-col">
                        {rows.map(({ item, time }) => {
                          const location = !item.entry.busy ? item.entry.location : null
                          const past = hasEnded(item, now)
                          return (
                            <li key={item.key}>
                              <button
                                type="button"
                                aria-label={itemLabel(item)}
                                onClick={(e) => onOpen?.(item, e.currentTarget)}
                                className="grid w-full grid-cols-[minmax(0,1fr)] items-center gap-x-3 gap-y-0.25 rounded-md px-2 py-2 text-left text-ui transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none sm:grid-cols-[9.5rem_minmax(0,1fr)]"
                              >
                                <span
                                  className={cn(
                                    "flex items-center gap-2 text-muted-foreground tabular-nums",
                                    !past && "sm:text-foreground",
                                  )}
                                >
                                  <ItemMark item={item} className="size-[0.6rem] rounded-full" />
                                  {time}
                                </span>
                                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 max-sm:pl-4.5">
                                  <span
                                    className={cn("truncate font-medium", past ? "text-muted-foreground" : "text-foreground", struck(item))}
                                  >
                                    {itemTitle(item)}
                                  </span>
                                  {item.person && !item.entry.busy && (
                                    <span className="truncate text-caption text-muted-foreground">{item.person.name}</span>
                                  )}
                                  {location && <span className="truncate text-caption text-muted-foreground">{location}</span>}
                                </span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
          {loaded && (
            <p className={cn(note, "pt-4 pb-8")}>
              {extending(true) ? (
                extraFailed ? (
                  extensionError
                ) : (
                  "Loading later events"
                )
              ) : (
                <>
                  Showing events until {formatShortDate(addDays(new Date(loaded.to), -1), today)}
                  <button type="button" onClick={extendAfter} disabled={!!pending} className={linkButton}>
                    Show more
                  </button>
                </>
              )}
            </p>
          )}
        </>
      )}
    </div>
  )
}
