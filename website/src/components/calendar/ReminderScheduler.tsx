import { useEffect, useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { Bell } from "@/components/icons"
import { useCalendarRange } from "@/lib/calendarStore"
import { dayKey } from "@/lib/dates"
import { eventRoom, openMeetingWindow } from "@/lib/meetingWindow"
import { notify } from "@/lib/notify"
import { useAuth } from "@/providers/AuthProvider"
import { itemTimeText, NO_TITLE } from "./items"
import { planReminders, pruneFired, reminderTitle, type Reminder } from "./reminders"

const HOUR_MS = 3_600_000
// The longest reminder is a day, so 26 hours from the start of the hour always covers it
const WINDOW_MS = 26 * HOUR_MS
// Timers drift while a laptop sleeps, so the plan is checked again at least this often
const MAX_WAIT_MS = 5 * 60_000
const STORAGE_KEY = "nerla-reminders-fired"

// Once per occurrence for this browser tab, also across reloads. Storage can be blocked, the set then lasts for this page only.
let fired: Set<string> | null = null
// Reminder toasts on screen, by key
const shown = new Set<string>()
let leaving: ReturnType<typeof setTimeout> | undefined

function firedSet(): Set<string> {
  if (fired) return fired
  let stored: string[] = []
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]")
    if (Array.isArray(value)) stored = value.filter((key): key is string => typeof key === "string")
  } catch {
    stored = []
  }
  fired = new Set(pruneFired(stored, Date.now()))
  return fired
}

function markFired(key: string) {
  const set = firedSet()
  set.add(key)
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pruneFired(set, Date.now())))
  } catch {
    // The in-memory set still holds the key
  }
}

function hourStart(): number {
  return Math.floor(Date.now() / HOUR_MS) * HOUR_MS
}

function show(reminder: Reminder, now: Date, open: (path: string) => void) {
  const { event, start, key } = reminder
  const title = reminderTitle(reminder, now)
  const name = event.title.trim() || NO_TITLE
  const body = itemTimeText(event)
  const label = (word: string) => (
    <>
      {word}
      <span className="sr-only"> {name}</span>
    </>
  )
  const forget = () => shown.delete(key)
  shown.add(key)
  toast(title, {
    id: key,
    description: body,
    icon: <Bell size={16} className="text-muted-foreground" />,
    duration: Infinity,
    closeButton: true,
    onDismiss: forget,
    onAutoClose: forget,
    action: event.video_call
      ? { label: label("Join"), onClick: () => void openMeetingWindow(eventRoom(event)) }
      : { label: label("Open"), onClick: () => open(`/calendar?date=${dayKey(start)}`) },
    classNames: event.video_call ? { actionButton: "bg-app-join! text-white!" } : undefined,
  })
  void notify(title, { body, tag: key })
}

function dismissShown(keep?: ReadonlySet<string>) {
  for (const key of [...shown]) {
    if (keep?.has(key)) continue
    shown.delete(key)
    toast.dismiss(key)
  }
}

/** Shows each reminder of the user's calendar as a toast and, when already allowed, an OS notification */
export function ReminderScheduler() {
  const navigate = useNavigate()
  const userId = useAuth().user?.id ?? null
  const [from, setFrom] = useState(hourStart)
  const { events, status } = useCalendarRange(new Date(from), new Date(from + WINDOW_MS))
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setFrom(hourStart()), HOUR_MS / 4)
    // After sleep or a hidden tab, a delayed timer catches up at once
    const replan = () => {
      if (document.visibilityState !== "visible") return
      setFrom(hourStart())
      setTick((count) => count + 1)
    }
    window.addEventListener("focus", replan)
    document.addEventListener("visibilitychange", replan)
    return () => {
      clearInterval(timer)
      window.removeEventListener("focus", replan)
      document.removeEventListener("visibilitychange", replan)
    }
  }, [])

  // Leaving the shell, as on sign-out, takes the toasts along. A remount straight after keeps them.
  useEffect(() => {
    clearTimeout(leaving)
    return () => {
      leaving = setTimeout(() => dismissShown(), 0)
    }
  }, [])

  useEffect(() => {
    const now = Date.now()
    const { due, nextAt, keys } = planReminders(events, now, firedSet(), userId)
    // A deleted or moved event takes its toast away
    if (status === "ready") dismissShown(keys)
    for (const reminder of due) {
      markFired(reminder.key)
      show(reminder, new Date(now), navigate)
    }
    if (nextAt === null) return
    const timer = setTimeout(() => setTick((count) => count + 1), Math.min(MAX_WAIT_MS, Math.max(0, nextAt - now)))
    return () => clearTimeout(timer)
  }, [events, status, tick, navigate, userId])

  return null
}
