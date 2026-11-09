import { useLayoutEffect, useRef, useState } from "react"
import { matchesMedia } from "./useMediaQuery"

/** Whether Nerla holds still, because the device asks or the user turned animations off. The root's data-motion says it */
export function reducedMotion(): boolean {
  const motion = typeof document === "undefined" ? null : document.documentElement.getAttribute("data-motion")
  return motion ? motion === "reduce" : matchesMedia("(prefers-reduced-motion: reduce)")
}

/** Smooth scrolling, or a jump when Nerla holds still */
export const scrollBehavior = (): ScrollBehavior => (reducedMotion() ? "auto" : "smooth")

/** Fades a Radix overlay or panel in and out on its data-state. Under reduced motion this is all that plays */
export const FADE_MOTION =
  "motion-panel data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"

/** Sheets that slide from an edge and fade */
export const SHEET_MOTION = {
  bottom: `${FADE_MOTION} motion-safe:data-[state=open]:slide-in-from-bottom motion-safe:data-[state=closed]:slide-out-to-bottom`,
  left: `${FADE_MOTION} motion-safe:data-[state=open]:slide-in-from-left motion-safe:data-[state=closed]:slide-out-to-left`,
  right: `${FADE_MOTION} motion-safe:data-[state=open]:slide-in-from-right motion-safe:data-[state=closed]:slide-out-to-right`,
}

/** The longest of a list of CSS times such as "0.2s, 150ms", in milliseconds */
function longestMs(times: string): number {
  return Math.max(
    0,
    ...times.split(",").map((time) => {
      const value = parseFloat(time)
      if (Number.isNaN(value)) return 0
      return time.trim().endsWith("ms") ? value : value * 1000
    }),
  )
}

/** Runs `done` once the node's own transition or animation ends, or after its duration when no end event comes */
function afterMotion(node: HTMLElement, kind: "transition" | "animation", done: () => void) {
  const style = getComputedStyle(node)
  const ms =
    kind === "animation" && style.animationName === "none"
      ? 0
      : longestMs(kind === "transition" ? style.transitionDuration : style.animationDuration)
  if (!ms) {
    done()
    return undefined
  }
  const event = kind === "transition" ? "transitionend" : "animationend"
  const onEnd = (e: Event) => {
    if (e.target === node) done()
  }
  node.addEventListener(event, onEnd)
  const timer = window.setTimeout(done, ms + 100)
  return () => {
    node.removeEventListener(event, onEnd)
    window.clearTimeout(timer)
  }
}

/**
 * Keeps an element mounted while its exit animation plays. The element takes `ref` and `data-state={state}`,
 * and is inert from the moment it starts to leave.
 */
export function usePresence<T extends HTMLElement = HTMLDivElement>(open: boolean) {
  const ref = useRef<T>(null)
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)

  useLayoutEffect(() => {
    const node = ref.current
    if (node) node.inert = !open
    if (open || !mounted) return
    if (!node) {
      setMounted(false)
      return
    }
    return afterMotion(node, "animation", () => setMounted(false))
  }, [open, mounted])

  return { ref, mounted, state: open ? ("open" as const) : ("closed" as const) }
}

export type Presence<T extends HTMLElement = HTMLDivElement> = ReturnType<typeof usePresence<T>>

type Phase = "open" | "closed" | "opening" | "expanding" | "closing"

/**
 * Drives a CSS transition between a closed and an open size. Closed content is inert as soon as it starts to
 * close and hidden once the transition ends, so nothing in it can take focus.
 */
export function useOpenTransition<T extends HTMLElement = HTMLDivElement>(open: boolean) {
  const ref = useRef<T>(null)
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed")
  if (open && phase === "closed") setPhase("opening")
  else if (open && phase === "closing") setPhase("expanding")
  else if (!open && (phase === "open" || phase === "opening" || phase === "expanding")) setPhase("closing")

  useLayoutEffect(() => {
    const node = ref.current
    if (node) node.inert = !open
    if (phase === "opening") {
      // Lays out the closed size first, so the change to open animates
      void node?.offsetHeight
      setPhase("expanding")
      return
    }
    if (phase !== "expanding" && phase !== "closing") return
    const next = phase === "expanding" ? "open" : "closed"
    if (!node) {
      setPhase(next)
      return
    }
    return afterMotion(node, "transition", () => setPhase(next))
  }, [open, phase])

  return {
    ref,
    /** Shown at the open size, or on its way there */
    expanded: phase === "open" || phase === "expanding",
    /** Fully open, so the content no longer needs clipping */
    settled: phase === "open",
    hidden: phase === "closed",
  }
}

/** How long the pointer rests on an avatar before its profile card opens */
export const HOVER_CARD_OPEN_MS = 450
/** How long after the pointer leaves the avatar and its card the card closes */
export const HOVER_CARD_CLOSE_MS = 250
/** A device with a mouse or trackpad, where a hover can open a card */
export const HOVER_POINTER_QUERY = "(hover: hover) and (pointer: fine)"
