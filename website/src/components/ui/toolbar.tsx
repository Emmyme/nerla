import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type ReactNode } from "react"
import { rovingIndex } from "@/lib/rovingFocus"

/** Marks a control as one of the toolbar's stops */
export const TOOL = { "data-tool": "" } as const

/**
 * A row of controls with one tab stop. Left and Right move between the controls marked with TOOL, Home and End go to
 * the ends, and Tab comes back to the one used last
 */
export function Toolbar({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const current = useRef(0)
  const tools = () => Array.from(box.current?.querySelectorAll<HTMLElement>("[data-tool]") ?? [])
  const settle = (list = tools()) => {
    if (current.current >= list.length) current.current = Math.max(0, list.length - 1)
    list.forEach((tool, index) => tool.setAttribute("tabindex", index === current.current ? "0" : "-1"))
  }

  // Tools come and go with the selection, so the one tab stop is kept after every render
  useLayoutEffect(() => settle())

  const onFocus = (event: FocusEvent) => {
    const list = tools()
    const index = list.indexOf(event.target as HTMLElement)
    if (index < 0 || index === current.current) return
    current.current = index
    settle(list)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const list = tools()
    const index = list.indexOf(event.target as HTMLElement)
    if (index < 0) return
    const next = rovingIndex(event.key, index, list.length)
    if (next === null) return
    event.preventDefault()
    // A board reads arrow keys too, and must not move the selected shapes
    event.stopPropagation()
    current.current = next
    settle(list)
    list[next].focus()
  }

  return (
    <div ref={box} role="toolbar" aria-label={label} onFocus={onFocus} onKeyDown={onKeyDown} className={className}>
      {children}
    </div>
  )
}
