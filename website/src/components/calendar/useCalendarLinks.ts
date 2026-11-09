import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react"
import { useSearchParams } from "react-router"
import { toast } from "sonner"
import type { TeamSelection } from "@/components/calendar/CalendarSide"
import type { CalendarItem } from "@/components/calendar/items"
import { allDayRange, parseDueDate, sameDay, startOfDay, type CalendarView } from "@/lib/dates"
import type { EventType } from "@/lib/eventColors"
import { colorForPerson } from "@/lib/personColors"
import { loadProfile } from "@/lib/profiles"

/** The event types the filters can hide */
export const TYPE_VALUES: readonly EventType[] = ["meeting", "event", "focus", "personal", "task"]
const PENDING_EVENT_MS = 10_000

type CalendarLinks = {
  go: (day: Date) => void
  userId: string | undefined
  team: TeamSelection[]
  setHidden: Dispatch<SetStateAction<ReadonlySet<EventType>>>
  /** Types shown again for a linked event, kept hidden in the saved choice */
  sessionShown: MutableRefObject<Set<EventType>>
  setVisiting: Dispatch<SetStateAction<TeamSelection | null>>
  days: Date[]
  items: CalendarItem[]
  status: string
  view: CalendarView
  setView: (view: CalendarView) => void
  openItem: (item: CalendarItem, anchor: HTMLElement) => void
  openNew: (kind: "meeting" | "ooo") => void
}

/** Follows the calendar's links: `?date=`, `?event=` with `?owner=` and `?type=`, and `?new=` */
export function useCalendarLinks({
  go,
  userId,
  team,
  setHidden,
  sessionShown,
  setVisiting,
  days,
  items,
  status,
  view,
  setView,
  openItem,
  openNew,
}: CalendarLinks) {
  const [searchParams, setSearchParams] = useSearchParams()

  // ?date=YYYY-MM-DD shows that day, as a reminder's Open does. ?event= then opens that event's details,
  // with ?owner= on that user's calendar and ?type= shown when the filters hide it
  const linkedDate = searchParams.get("date")
  const linkedEvent = searchParams.get("event")
  const [pendingEvent, setPendingEvent] = useState<{ id: string; day: Date } | null>(null)
  const pendingShown = useRef(false)
  useEffect(() => {
    if (linkedDate === null && linkedEvent === null) return
    const day = linkedDate === null ? null : parseDueDate(linkedDate)
    if (day) go(day)
    if (linkedEvent) {
      const owner = searchParams.get("owner")
      const type = searchParams.get("type") as EventType | null
      if (type && TYPE_VALUES.includes(type)) {
        setHidden((shown) => {
          if (!shown.has(type)) return shown
          sessionShown.current.add(type)
          const next = new Set(shown)
          next.delete(type)
          return next
        })
      }
      if (owner && owner !== userId && !team.some((person) => person.id === owner && person.shown)) {
        setVisiting({ id: owner, name: team.find((person) => person.id === owner)?.name ?? "", tone: colorForPerson(owner), shown: true })
        if (userId) {
          void loadProfile(userId, owner).then((entry) => {
            if (entry.status !== "ready") return
            const name = [entry.profile.first_name, entry.profile.last_name].filter(Boolean).join(" ") || entry.profile.email
            setVisiting((current) => (current?.id === owner ? { ...current, name } : current))
          })
        }
      }
      pendingShown.current = false
      setPendingEvent({ id: linkedEvent, day: day ?? startOfDay(new Date()) })
    }
    setSearchParams(
      (params) => {
        for (const name of ["date", "event", "owner", "type"]) params.delete(name)
        return params
      },
      { replace: true },
    )
  }, [linkedDate, linkedEvent, go, setSearchParams, searchParams, userId, team, setHidden, sessionShown, setVisiting])

  // A search result that never shows stops waiting, so a later visit to that day opens nothing by surprise
  useEffect(() => {
    if (!pendingEvent) return
    const timer = setTimeout(() => setPendingEvent(null), PENDING_EVENT_MS)
    return () => clearTimeout(timer)
  }, [pendingEvent])

  // ?new=meeting opens the editor for a new meeting, as the shell's New meeting does, and ?new=ooo one for out of office
  useEffect(() => {
    const kind = searchParams.get("new")
    if ((kind !== "meeting" && kind !== "ooo") || status === "loading") return
    setSearchParams(
      (params) => {
        params.delete("new")
        return params
      },
      { replace: true },
    )
    openNew(kind)
  }, [searchParams, setSearchParams, status, openNew])

  // Waits for the day's events, then opens the one on that day. Schedule and a full month cell may not show it, so the day view does
  useEffect(() => {
    if (!pendingEvent) return
    const inView = days.some((day) => sameDay(day, pendingEvent.day))
    // Moving elsewhere after the day was in view means the user has gone on
    if (!inView && pendingShown.current) return setPendingEvent(null)
    if (!inView || status === "loading") return
    pendingShown.current = true
    const { id, day } = pendingEvent
    const matching = items.filter((item) => !item.entry.busy && (item.entry.id === id || item.entry.series_id === id))
    const onDay = (item: CalendarItem) => {
      const range = allDayRange(item)
      return !!range && range.first <= day && day <= range.last
    }
    const item = matching.find(onDay) ?? matching[0]
    const anchor = item ? document.querySelector<HTMLElement>(`[data-event-key="${CSS.escape(item.key)}"]`) : null
    if (item && !anchor && view !== "day") return setView("day")
    setPendingEvent(null)
    if (!item || !anchor) return void toast.error("Couldn't find that event")
    anchor.scrollIntoView({ block: "center" })
    openItem(item, anchor)
  }, [pendingEvent, status, days, items, view, setView, openItem])
}
