import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { remPx } from "@/lib/utils"
import type { NudgeItem } from "./EventBlock"
import type { CalendarItem } from "./items"
import type { EventDraft } from "./draft"
import { dragMove, dragResize, type EventTimes, type Range, type Slot } from "./timeMath"

const DRAG_THRESHOLD_REM = 0.3
const TOUCH_HOLD_MS = 300
const EDGE_REM = 2.5
const MAX_SCROLL_REM = 0.9

type GridTarget<T> = { kind: "empty" } | { kind: "move" | "resize"; item: T }
type GridDrag<T> = { target: GridTarget<T>; from: Slot; to: Slot }

type Options<T> = {
  /** The slot under the pointer. `from` is the slot pressed, so a view can keep a drag in its day. */
  slotAt: (x: number, y: number, target: GridTarget<T>, from: Slot | null) => Slot | null
  /** Scrolls when a drag nears its top or bottom edge, and stops the page scrolling during a touch drag */
  scroller?: RefObject<HTMLElement | null>
  /** Where the visible grid starts below a sticky header, in client px */
  topEdge?: () => number
  /** Off for a strip that does not scroll, such as the all-day row */
  autoscroll?: boolean
  /** Empty presses only dismiss, while a popover is open */
  dismissing?: boolean
  onTap?: (slot: Slot) => void
  onSelect?: (from: Slot, to: Slot) => void
  onDrop?: (target: Exclude<GridTarget<T>, { kind: "empty" }>, from: Slot, to: Slot) => void
}

type Gesture<T> = {
  pointerId: number
  touch: boolean
  x: number
  y: number
  lastX: number
  lastY: number
  target: GridTarget<T>
  from: Slot
  to: Slot
  started: boolean
  hold?: ReturnType<typeof setTimeout>
}

const sameSlot = (a: Slot, b: Slot) => a.dayIndex === b.dayIndex && a.at.getTime() === b.at.getTime()

// A click that ends a drag must not also open the event under it
function swallowNextClick() {
  const stop = (event: MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
  }
  window.addEventListener("click", stop, { capture: true, once: true })
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0)
}

/**
 * Pointer gestures on a calendar grid. A press that moves more than 0.3rem is a drag, anything less
 * is a click. Touch needs a 300 ms hold first, so a swipe still scrolls.
 */
export function useGridPointer<T>(options: Options<T>) {
  const latest = useRef(options)
  latest.current = options
  const gesture = useRef<Gesture<T> | null>(null)
  const frame = useRef(0)
  // After a touch the grid handled, the browser's emulated mouse events would blur the new popover
  const quietTouch = useRef(false)
  // A drag cancelled with Escape still ends in a release, whose click must not open the event
  const cancelled = useRef<number | null>(null)
  const [drag, setDrag] = useState<GridDrag<T> | null>(null)

  const publish = useCallback(() => {
    const g = gesture.current
    setDrag(g?.started ? { target: g.target, from: g.from, to: g.to } : null)
  }, [])

  const track = useCallback(
    (x: number, y: number) => {
      const g = gesture.current
      if (!g) return
      g.lastX = x
      g.lastY = y
      const next = latest.current.slotAt(x, y, g.target, g.from)
      if (next && !sameSlot(next, g.to)) {
        g.to = next
        if (g.started) publish()
      }
    },
    [publish],
  )

  const autoscroll = useCallback(() => {
    cancelAnimationFrame(frame.current)
    const tick = () => {
      const g = gesture.current
      const node = latest.current.scroller?.current
      if (!g?.started || !node) return
      const rect = node.getBoundingClientRect()
      const top = Math.max(rect.top, latest.current.topEdge?.() ?? rect.top)
      const rem = remPx()
      const edge = EDGE_REM * rem
      let delta = 0
      if (g.lastY < top + edge) delta = -Math.min(1, (top + edge - g.lastY) / edge)
      else if (g.lastY > rect.bottom - edge) delta = Math.min(1, (g.lastY - (rect.bottom - edge)) / edge)
      if (delta !== 0) {
        const before = node.scrollTop
        node.scrollTop += delta * MAX_SCROLL_REM * rem
        if (node.scrollTop !== before) track(g.lastX, g.lastY)
      }
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [track])

  const end = useCallback((commit: boolean) => {
    const g = gesture.current
    if (!g) return
    clearTimeout(g.hold)
    cancelAnimationFrame(frame.current)
    gesture.current = null
    setDrag(null)
    if (!commit) return
    const { onTap, onSelect, onDrop } = latest.current
    if (g.touch && (g.started || g.target.kind === "empty")) quietTouch.current = true
    if (!g.started) {
      if (g.target.kind === "empty") onTap?.(g.from)
      return
    }
    if (g.target.kind !== "empty") {
      swallowNextClick()
      onDrop?.(g.target, g.from, g.to)
    } else if (g.touch && sameSlot(g.from, g.to)) {
      // A touch held without moving makes the same half hour as a tap
      onTap?.(g.from)
    } else onSelect?.(g.from, g.to)
  }, [])

  const begin = useCallback(() => {
    const g = gesture.current
    if (!g || g.started) return
    g.started = true
    publish()
    if (latest.current.autoscroll !== false) autoscroll()
  }, [autoscroll, publish])

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const g = gesture.current
      if (!g || event.pointerId !== g.pointerId) return
      const moved = Math.hypot(event.clientX - g.x, event.clientY - g.y) > DRAG_THRESHOLD_REM * remPx()
      if (!g.started) {
        if (!moved) return
        // A touch that moves before the hold is a scroll
        if (g.touch) return end(false)
        begin()
      }
      track(event.clientX, event.clientY)
    }
    const onUp = (event: PointerEvent) => {
      if (cancelled.current === event.pointerId) {
        cancelled.current = null
        swallowNextClick()
      }
      if (gesture.current?.pointerId === event.pointerId) end(true)
    }
    // A release lost outside the window must not cost a later click
    const onDown = () => {
      cancelled.current = null
    }
    const onCancel = (event: PointerEvent) => {
      if (gesture.current?.pointerId === event.pointerId) end(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current?.started) {
        event.preventDefault()
        event.stopPropagation()
        cancelled.current = gesture.current.pointerId
        end(false)
      }
    }
    window.addEventListener("pointerdown", onDown, true)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    window.addEventListener("keydown", onKey, true)
    return () => {
      window.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      window.removeEventListener("keydown", onKey, true)
      cancelAnimationFrame(frame.current)
    }
  }, [begin, end, track])

  // Registered before any touch starts, and not passive, so the page holds still once a drag begins
  useEffect(() => {
    const node = latest.current.scroller?.current
    if (!node) return
    const onTouchMove = (event: TouchEvent) => {
      if (gesture.current?.started) event.preventDefault()
    }
    const onTouchEnd = (event: TouchEvent) => {
      if (!quietTouch.current) return
      quietTouch.current = false
      if (event.cancelable) event.preventDefault()
    }
    const onContextMenu = (event: Event) => {
      if (gesture.current?.touch) event.preventDefault()
    }
    node.addEventListener("touchmove", onTouchMove, { passive: false })
    node.addEventListener("touchend", onTouchEnd, { passive: false })
    node.addEventListener("contextmenu", onContextMenu)
    return () => {
      node.removeEventListener("touchmove", onTouchMove)
      node.removeEventListener("touchend", onTouchEnd)
      node.removeEventListener("contextmenu", onContextMenu)
    }
  }, [])

  const start = useCallback(
    (event: ReactPointerEvent, target: GridTarget<T>) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey) return
      // A release outside the window never arrives, so an older gesture gives way
      if (gesture.current) end(false)
      if (target.kind === "empty" && latest.current.dismissing) return
      const from = latest.current.slotAt(event.clientX, event.clientY, target, null)
      if (!from) return
      const touch = event.pointerType === "touch"
      const g: Gesture<T> = {
        pointerId: event.pointerId,
        touch,
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        target,
        from,
        to: from,
        started: false,
      }
      gesture.current = g
      if (touch) g.hold = setTimeout(begin, TOUCH_HOLD_MS)
    },
    [begin, end],
  )

  return { drag, start }
}

/** What the views share to make and change events */
export type GridActions = {
  /** The draft being made, drawn as a ghost the quick-create popover anchors to */
  draft?: EventDraft | null
  /** A popover is open, so a press on empty time only closes it */
  dismissing?: boolean
  canMove?: (item: CalendarItem) => boolean
  onCreate?: (range: Range, allDay: boolean) => void
  /** Resolves once the change is on its way, the preview holds until then */
  onChangeTimes?: (item: CalendarItem, times: EventTimes) => Promise<unknown> | void
  onNudge?: NudgeItem
  /** Changes when Create or C makes a draft, so the grid brings it into view */
  reveal?: number
}

export const withTimes = (item: CalendarItem, times: EventTimes): CalendarItem => ({
  ...item,
  starts_at: times.starts_at,
  ends_at: times.ends_at,
})

const unchanged = (item: CalendarItem, times: EventTimes) =>
  new Date(times.starts_at).getTime() === new Date(item.starts_at ?? "").getTime() &&
  new Date(times.ends_at).getTime() === new Date(item.ends_at ?? "").getTime()

/** The moved copy of the item under a drag, or null for a drag on empty time */
export function dragPreview(drag: GridDrag<CalendarItem> | null): CalendarItem | null {
  if (!drag || drag.target.kind === "empty") return null
  const { item } = drag.target
  return withTimes(item, drag.target.kind === "move" ? dragMove(item, drag.from, drag.to) : dragResize(item, drag.from, drag.to))
}

/** Finds the event a press landed on, or reports empty space. Read-only events and other buttons are left to their clicks. */
export function pressTarget(event: ReactPointerEvent, byKey: Map<string, CalendarItem>): GridTarget<CalendarItem> | null {
  const element = event.target as Element
  const block = element.closest<HTMLElement>("[data-event-key]")
  if (block) {
    const item = block.dataset.draggable !== undefined ? byKey.get(block.dataset.eventKey ?? "") : undefined
    return item ? { kind: element.closest("[data-resize]") ? "resize" : "move", item } : null
  }
  return element.closest("button, a, input, textarea, select") ? null : { kind: "empty" }
}

/** Holds the moved copy after a drop until the change is on its way, so the block never snaps back */
export function useDrop(onChangeTimes: GridActions["onChangeTimes"]) {
  const [held, setHeld] = useState<CalendarItem | null>(null)
  const drop = useCallback(
    (item: CalendarItem, times: EventTimes) => {
      if (unchanged(item, times) || !onChangeTimes) return
      setHeld(withTimes(item, times))
      void Promise.resolve(onChangeTimes(item, times)).finally(() => setHeld(null))
    },
    [onChangeTimes],
  )
  return { held, drop }
}
