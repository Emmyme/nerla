import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from "@tiptap/suggestion"
import { usePortalContainer } from "@/components/ui/portal-container"
import { cn, remPx } from "@/lib/utils"

type MenuItem = { key: string; label: string; icon: ReactNode }

type MenuState = { label: string; items: MenuItem[]; active: number; rect: DOMRect | null; pick: (index: number) => void }

/** The open suggestion list of one editor, slash or mention, which the editor's menu draws */
export class SuggestionMenuStore {
  private state: MenuState | null = null
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get = () => this.state

  private set(next: MenuState | null) {
    this.state = next
    this.listeners.forEach((listener) => listener())
  }

  /** The suggestion plugin's `render`, which keeps this store in step and answers the arrow keys */
  renderer<I>(label: string, toItem: (item: I) => MenuItem): NonNullable<SuggestionOptions<I>["render"]> {
    return () => {
      let props: SuggestionProps<I> | null = null
      const show = (next: SuggestionProps<I>, active = 0) => {
        props = next
        if (next.items.length === 0) return this.set(null)
        this.set({
          label,
          items: next.items.map(toItem),
          active: Math.min(active, next.items.length - 1),
          rect: next.clientRect?.() ?? null,
          pick: (index) => {
            const item = next.items[index]
            if (item !== undefined) next.command(item)
          },
        })
      }
      return {
        onStart: (next) => show(next),
        onUpdate: (next) => show(next, 0),
        onExit: () => {
          props = null
          this.set(null)
        },
        onKeyDown: ({ event }: SuggestionKeyDownProps) => {
          const state = this.state
          if (!state || !props || event.isComposing) return false
          const count = state.items.length
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const step = event.key === "ArrowDown" ? 1 : -1
            this.set({ ...state, active: (state.active + step + count) % count })
            return true
          }
          if (event.key === "Enter" || event.key === "Tab") {
            state.pick(state.active)
            return true
          }
          return false
        },
      }
    }
  }

  hover(index: number) {
    if (this.state && this.state.active !== index) this.set({ ...this.state, active: index })
  }
}

/** The list under the typed `/` or `@`, kept on screen */
export function SuggestionMenu({ store }: { store: SuggestionMenuStore }) {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get)
  const list = useRef<HTMLDivElement>(null)
  const container = usePortalContainer()

  useEffect(() => {
    const active = list.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    active?.scrollIntoView({ block: "nearest" })
  }, [state?.active])

  if (!state?.rect) return null
  const rem = remPx()
  const width = 15 * rem
  const left = Math.max(0.5 * rem, Math.min(state.rect.left, window.innerWidth - width - 0.5 * rem))
  const below = window.innerHeight - state.rect.bottom > 22 * rem
  const position = below
    ? { top: `${(state.rect.bottom + 0.3 * rem) / rem}rem` }
    : { bottom: `${(window.innerHeight - state.rect.top + 0.3 * rem) / rem}rem` }

  return createPortal(
    <div
      ref={list}
      role="listbox"
      aria-label={state.label}
      style={{ left: `${left / rem}rem`, ...position }}
      className="fixed z-50 max-h-[21.5rem] w-[15rem] overflow-y-auto rounded-lg border-[0.0625rem] border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-popover)]"
    >
      {state.items.map((item, index) => (
        <div
          key={item.key}
          role="option"
          aria-selected={index === state.active}
          // The editor keeps focus, so typing carries on
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onPointerMove={() => store.hover(index)}
          onClick={() => state.pick(index)}
          className={cn(
            "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-ui font-medium text-foreground max-lg:min-h-11",
            index === state.active && "bg-app-selected",
          )}
        >
          <span className="flex shrink-0 text-muted-foreground">{item.icon}</span>
          <span className="truncate">{item.label}</span>
        </div>
      ))}
    </div>,
    container ?? document.body,
  )
}
