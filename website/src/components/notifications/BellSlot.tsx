import { useLayoutEffect, useRef } from "react"

// The top right of each page header offers a slot, and the bell sits in the newest one
const slots: HTMLElement[] = []
const slotListeners = new Set<() => void>()
export const topSlot = () => slots[slots.length - 1] ?? null
export const subscribeSlots = (listener: () => void) => {
  slotListeners.add(listener)
  return () => {
    slotListeners.delete(listener)
  }
}

/** Where the bell goes in a page's header, at its top right. The desktop window keeps it in the title bar instead */
export function BellSlot() {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    slots.push(node)
    slotListeners.forEach((listener) => listener())
    return () => {
      slots.splice(slots.indexOf(node), 1)
      slotListeners.forEach((listener) => listener())
    }
  }, [])
  return <span ref={ref} className="contents" />
}
