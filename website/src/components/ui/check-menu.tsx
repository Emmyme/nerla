import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Check } from "@/components/icons"
import { cn } from "@/lib/utils"

export const MENU_ITEM =
  "flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ui font-medium text-foreground outline-none transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover max-lg:min-h-11"

const ITEMS = '[role^="menuitem"]'

/**
 * The open state of a menu that a button opens. Opening focuses the first item, arrows, Home and End move,
 * Escape closes back to the button, Tab and a press outside close it.
 */
export function useMenuKeys() {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>(ITEMS)?.focus()
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open])

  const close = () => {
    setOpen(false)
    button.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])
    const index = items.indexOf(document.activeElement as HTMLElement)
    const move = (next: number) => {
      event.preventDefault()
      items[(next + items.length) % items.length]?.focus()
    }
    if (event.key === "ArrowDown") move(index + 1)
    else if (event.key === "ArrowUp") move(index - 1)
    else if (event.key === "Home") move(0)
    else if (event.key === "End") move(items.length - 1)
    else if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === "Tab") setOpen(false)
  }

  return { open, setOpen, button, menu, close, onKeyDown }
}

/** A row with a check box, a menu item by default or a plain checkbox outside a menu */
export function CheckItem({
  checked,
  onToggle,
  label,
  icon,
  menu = true,
}: {
  checked: boolean
  onToggle: () => void
  label: string
  icon?: ReactNode
  menu?: boolean
}) {
  return (
    <button
      type="button"
      role={menu ? "menuitemcheckbox" : "checkbox"}
      aria-checked={checked}
      tabIndex={menu ? -1 : undefined}
      onClick={onToggle}
      className={MENU_ITEM}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-[0.875rem] shrink-0 items-center justify-center rounded-sm",
          checked ? "bg-app-sky text-app-sky-ink" : "border-[0.0625rem] border-muted-foreground",
        )}
      >
        {checked && <Check weight="bold" className="size-[0.625rem]" />}
      </span>
      {icon && (
        <span aria-hidden="true" className="flex shrink-0">
          {icon}
        </span>
      )}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}
