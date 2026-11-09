import { useEffect, useState, type FocusEvent, type KeyboardEvent } from "react"
import { rovingIndex } from "@/lib/rovingFocus"

const ITEM = "[data-roving-item]"
const ROW = "[data-roving-row]"
const ACTION = "[data-row-action]"

const itemOf = (target: Element) =>
  (target.closest(ACTION) ? target.closest(ROW)?.querySelector<HTMLElement>(ITEM) : target.closest<HTMLElement>(ITEM)) ?? null

/**
 * A vertical list that is one Tab stop. Up, Down, Home and End move between its items, Right reaches the buttons of
 * the item's row and Left goes back. Tabbing in lands on `current`, the item for the current page, or the first
 */
export function useRovingList(keys: string[], current: string | null) {
  const [focused, setFocused] = useState<string | null>(null)
  const stop = focused && keys.includes(focused) ? focused : current && keys.includes(current) ? current : keys[0]
  const gone = !!focused && !keys.includes(focused)
  useEffect(() => {
    if (gone) setFocused(null)
  }, [gone])

  const list = {
    onFocus: (event: FocusEvent<HTMLElement>) => {
      const item = itemOf(event.target)
      if (item) setFocused(item.dataset.rovingItem ?? null)
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocused(null)
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof Element)) return
      const item = itemOf(event.target)
      if (!item) return
      const action = event.target.closest<HTMLElement>(ACTION)
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        const next =
          event.key === "ArrowLeft" ? (action ? item : null) : action ? null : item.closest(ROW)?.querySelector<HTMLElement>(ACTION)
        if (!next) return
        event.preventDefault()
        next.focus()
        return
      }
      // Rows on their way out stay in the page while they fold away
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ITEM)).filter((el) =>
        keys.includes(el.dataset.rovingItem ?? ""),
      )
      const next = rovingIndex(event.key, items.indexOf(item), items.length, "vertical")
      if (next === null) return
      event.preventDefault()
      items[next].focus()
    },
  }

  const item = (key: string) => ({ "data-roving-item": key, tabIndex: key === stop ? 0 : -1 })
  return { list, item }
}

/** A button in a roving list's row, reached with Right from the row's item */
export const rowAction = { "data-row-action": "", tabIndex: -1 } as const
