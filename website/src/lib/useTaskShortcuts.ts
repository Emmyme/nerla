import { useEffect, useRef } from "react"
import { keyActions, shouldIgnoreKey } from "@/lib/shortcuts"

export { shouldIgnoreKey }

type TaskShortcut = "new" | "next" | "prev" | "open" | "close" | "status" | "priority" | "assignee"

const SHORTCUT_BY_KEY = keyActions<TaskShortcut>("tasks")
const ARROWS = new Set(["arrowdown", "arrowup"])
const TASK_NAV = "[data-task-nav]"
const ACTIVATES_ON_ENTER = 'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"]'

export function useTaskShortcuts(handlers: Partial<Record<TaskShortcut, () => void>>) {
  const latest = useRef(handlers)
  latest.current = handlers

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || shouldIgnoreKey(e)) return
      if (e.key === "Enter" && e.target instanceof Element && e.target.closest(ACTIVATES_ON_ENTER)) return
      const key = e.key?.toLowerCase()
      // Arrow keys scroll the page unless focus is inside a task list or board
      if (ARROWS.has(key) && !(e.target instanceof Element && e.target.closest(TASK_NAV))) return
      const shortcut = SHORTCUT_BY_KEY.get(key)
      const handler = shortcut && latest.current[shortcut]
      if (!handler) return
      e.preventDefault()
      handler()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
