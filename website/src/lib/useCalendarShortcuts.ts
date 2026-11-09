import { useEffect, useRef } from "react"
import { keyActions, shouldIgnoreKey } from "@/lib/shortcuts"

type CalendarShortcut = "day" | "week" | "month" | "schedule" | "today" | "prev" | "next" | "create" | "meeting" | "close"

// As in Google Calendar, J goes forward, K goes back and A opens the agenda (Schedule)
const SHORTCUT_BY_KEY = keyActions<CalendarShortcut>("calendar")

export function useCalendarShortcuts(handlers: Partial<Record<CalendarShortcut, () => void>>) {
  const latest = useRef(handlers)
  latest.current = handlers

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.shiftKey || shouldIgnoreKey(e)) return
      const shortcut = SHORTCUT_BY_KEY.get(e.key?.toLowerCase())
      const handler = shortcut && latest.current[shortcut]
      if (!handler) return
      e.preventDefault()
      handler()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
