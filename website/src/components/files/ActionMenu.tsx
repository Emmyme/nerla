import { useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Ellipsis, type IconComponent } from "@/components/icons"
import { AnchoredPopover, type VirtualAnchor } from "@/components/ui/anchored-popover"
import { runFromMenu } from "@/lib/dialogOpener"
import { cn, remPx } from "@/lib/utils"

/** `shortcut` is announced only, since a menu item already shows its icon */
export type MenuEntry = { label: string; Icon: IconComponent; run: () => void; danger?: boolean; shortcut?: string; disabled?: boolean }

/** A press on the button this soon after the menu closed is the same press, so it doesn't reopen the menu */
const REOPEN_GUARD_MS = 250

const ITEM =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ui font-medium outline-none transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover max-lg:min-h-11"

/** Where a menu sits: under `element`, lined up with its right edge, or its left edge with `align="start"` */
function anchorFor(element: () => HTMLElement | null, align: "start" | "end", widthRem: number): VirtualAnchor {
  return {
    getBoundingClientRect: () => {
      const box = element()?.getBoundingClientRect() ?? { top: 0, bottom: 0, left: 0, right: 0 }
      const rem = remPx()
      const left = align === "start" ? box.left : box.right - widthRem * rem
      return { top: box.top, bottom: box.bottom, right: box.right, left }
    },
    element,
  }
}

/**
 * The menu itself, worked by arrow keys, Home and End, for a button that keeps its own look. It flips above the
 * button when there is no room below
 */
export function MenuPopover({
  open,
  onOpenChange,
  anchor,
  label,
  entries,
  align = "end",
  widthRem = 12.5,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: () => HTMLElement | null
  label: string
  entries: MenuEntry[]
  align?: "start" | "end"
  widthRem?: number
}) {
  const menu = useRef<HTMLDivElement>(null)

  const choose = (entry: MenuEntry) => {
    if (entry.disabled) return
    onOpenChange(false)
    runFromMenu(anchor(), entry.run)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const index = items.indexOf(document.activeElement as HTMLElement)
    const move = (next: number) => {
      event.preventDefault()
      items[(next + items.length) % items.length]?.focus()
    }
    if (event.key === "ArrowDown") move(index + 1)
    else if (event.key === "ArrowUp") move(index - 1)
    else if (event.key === "Home") move(0)
    else if (event.key === "End") move(items.length - 1)
    // Tab closes the menu and focus goes back to its button
    else if (event.key === "Tab") {
      event.preventDefault()
      onOpenChange(false)
    }
  }

  return (
    <AnchoredPopover
      open={open}
      onOpenChange={onOpenChange}
      anchor={open ? anchorFor(anchor, align, widthRem) : null}
      side="bottom"
      title={label}
      // Only when the menu took focus away with it, never from wherever a chosen entry sent it
      returnFocus={() => {
        if (!document.activeElement || document.activeElement === document.body) anchor()?.focus()
      }}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus())
      }}
      className="p-1"
    >
      <div
        ref={menu}
        role="menu"
        aria-label={label}
        onKeyDown={onKeyDown}
        style={{ width: `${widthRem - 0.5}rem` }}
        className="flex flex-col"
      >
        {entries.map((entry) => (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-keyshortcuts={entry.shortcut}
            aria-disabled={entry.disabled || undefined}
            onClick={() => choose(entry)}
            className={cn(
              ITEM,
              entry.danger ? "text-app-berry-text" : "text-foreground",
              entry.disabled && "cursor-default opacity-50 hover:bg-transparent",
            )}
          >
            <entry.Icon aria-hidden="true" className={cn("size-[1rem]", entry.danger ? "text-app-berry-text" : "text-muted-foreground")} />
            {entry.label}
          </button>
        ))}
      </div>
    </AnchoredPopover>
  )
}

/** The open state of a button that opens a menu, with the keys and wiring both take */
export function useMenuButton() {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  // A press on the button while the menu is open closes it as a press outside, so that click must not reopen it
  const closedAt = useRef(0)
  return {
    open,
    button,
    toggle: () => {
      if (Date.now() - closedAt.current >= REOPEN_GUARD_MS) setOpen((shown) => !shown)
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "ArrowDown") return
      event.preventDefault()
      setOpen(true)
    },
    popover: {
      open,
      onOpenChange: (next: boolean) => {
        if (!next) closedAt.current = Date.now()
        setOpen(next)
      },
      anchor: () => button.current,
    },
  }
}

/** A button that opens a menu of entries */
export function ActionMenu({
  label,
  entries,
  className,
  trigger,
  title,
  align = "end",
  widthRem = 12.5,
  disabled = false,
}: {
  label: string
  entries: MenuEntry[]
  className?: string
  trigger?: ReactNode
  title?: string
  align?: "start" | "end"
  widthRem?: number
  disabled?: boolean
}) {
  const menu = useMenuButton()
  if (entries.length === 0) return null

  return (
    <>
      <button
        ref={menu.button}
        type="button"
        aria-label={label}
        title={title}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-disabled={disabled || undefined}
        onClick={(event) => {
          event.stopPropagation()
          if (!disabled) menu.toggle()
        }}
        onKeyDown={(event) => !disabled && menu.onKeyDown(event)}
        className={cn(
          "relative z-10 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none aria-disabled:pointer-events-none aria-disabled:opacity-50 max-lg:size-11",
          menu.open && "bg-app-hover text-foreground",
          className,
        )}
      >
        {trigger ?? <Ellipsis aria-hidden="true" weight="bold" className="size-[1rem]" />}
      </button>
      <MenuPopover {...menu.popover} label={label} entries={entries} align={align} widthRem={widthRem} />
    </>
  )
}
