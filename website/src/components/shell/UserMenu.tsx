import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { useNavigate } from "react-router"
import { Away, Check, LogOut, Monitor, Moon, Settings, Sun } from "@/components/icons"
import { AnchoredPopover, type PopoverSide } from "@/components/ui/anchored-popover"
import { useDarkMode, type ThemeModePreference } from "@/contexts/DarkModeContext"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"
import { StatusChoices, StatusRow } from "./StatusPicker"

export const THEMES: { value: ThemeModePreference; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
]

const ITEM =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ui font-medium text-foreground outline-none transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-inset focus-visible:ring-ring"
const ICON = "size-[1rem] shrink-0 text-muted-foreground"
const SEPARATOR = "my-1 h-[0.0625rem] bg-border"
const LABEL = "px-2.5 pb-1 pt-1 text-caption text-muted-foreground"

export const SET_AWAY_PATH = "/calendar?new=ooo"

/** The user's email, status, out of office, Settings, the theme and Sign out, opened from the user's row at the bottom of the sidebar */
export function UserMenu({
  open,
  onOpenChange,
  anchor,
  side,
  returnFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: HTMLElement | null
  side: PopoverSide
  returnFocus: () => void
}) {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const { themeMode, setThemeMode } = useDarkMode()
  const menu = useRef<HTMLDivElement>(null)
  const themeLabel = useId()
  const [view, setView] = useState<"main" | "status">("main")
  // A switch of view moves focus to the first item of the new one
  const switched = useRef(false)

  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])

  useEffect(() => {
    if (!open) setView("main")
  }, [open])

  useEffect(() => {
    if (!switched.current) return
    switched.current = false
    const list = items()
    const target = view === "status" ? list.find((item) => item.getAttribute("aria-checked") === "true") : list[0]
    ;(target ?? list[0])?.focus()
  }, [view])

  const show = (next: "main" | "status") => {
    switched.current = true
    setView(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items()
    const index = list.indexOf(document.activeElement as HTMLElement)
    const move = (next: number) => {
      event.preventDefault()
      list[(next + list.length) % list.length]?.focus()
    }
    if (event.key === "ArrowDown") move(index + 1)
    else if (event.key === "ArrowUp") move(index - 1)
    else if (event.key === "Home") move(0)
    else if (event.key === "End") move(list.length - 1)
    else if (event.key === "ArrowLeft" && view === "status") {
      event.preventDefault()
      show("main")
    } else if (event.key === "Tab") {
      event.preventDefault()
      onOpenChange(false)
    }
  }

  return (
    <AnchoredPopover
      open={open}
      onOpenChange={onOpenChange}
      anchor={anchor}
      side={side}
      title="Account menu"
      className="w-[13.5rem] p-1"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        items()[0]?.focus()
      }}
      returnFocus={returnFocus}
    >
      <div ref={menu} role="menu" aria-label={view === "status" ? "Status" : "Account"} onKeyDown={onKeyDown} className="flex flex-col">
        {view === "status" ? (
          <StatusChoices
            variant="menu"
            itemClass={ITEM}
            iconClass={ICON}
            labelClass={LABEL}
            separator={SEPARATOR}
            onBack={() => show("main")}
          />
        ) : (
          <>
            {user?.email && (
              <p title={user.email} className={cn(LABEL, "truncate pb-1.5")}>
                {user.email}
              </p>
            )}
            <StatusRow variant="menu" className={ITEM} iconClass={ICON} onOpen={() => show("status")} />
            <div role="separator" className={SEPARATOR} />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={ITEM}
              onClick={() => {
                onOpenChange(false)
                navigate(SET_AWAY_PATH)
              }}
            >
              <Away aria-hidden="true" className={ICON} />
              Set out of office
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={ITEM}
              onClick={() => {
                onOpenChange(false)
                navigate("/settings")
              }}
            >
              <Settings aria-hidden="true" className={ICON} />
              Settings
            </button>
            <div role="separator" className={SEPARATOR} />
            <div role="group" aria-labelledby={themeLabel}>
              <p id={themeLabel} className={LABEL}>
                Theme
              </p>
              {THEMES.map(({ value, label, Icon }) => {
                const checked = themeMode === value
                return (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    tabIndex={-1}
                    className={ITEM}
                    onClick={() => setThemeMode(value)}
                  >
                    <Icon aria-hidden="true" className={ICON} />
                    {label}
                    <Check aria-hidden="true" weight="bold" className={cn("ml-auto size-3.5 shrink-0", !checked && "invisible")} />
                  </button>
                )
              })}
            </div>
            <div role="separator" className={SEPARATOR} />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={ITEM}
              onClick={() => {
                onOpenChange(false)
                logout()
              }}
            >
              <LogOut aria-hidden="true" className={ICON} />
              Sign out
            </button>
          </>
        )}
      </div>
    </AnchoredPopover>
  )
}
