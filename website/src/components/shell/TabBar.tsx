import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router"
import { useCommandMenu } from "@/components/command/registry"
import {
  Away,
  Calendar,
  Check,
  Ellipsis,
  Folder,
  House,
  LogOut,
  MessageCircle,
  Projects,
  Search,
  Settings,
  Timer,
  type IconComponent,
} from "@/components/icons"
import { TimerClock } from "@/components/time/TimerClock"
import { BottomSheet } from "@/components/ui/bottom-sheet"
import { UnreadDot } from "@/components/ui/unread-dot"
import { UserAvatar } from "@/components/ui/user-avatar"
import { useDarkMode } from "@/contexts/DarkModeContext"
import { useTotalUnread } from "@/lib/chatHooks"
import { useAvatarSrc } from "@/lib/useAvatarSrc"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { useTimeTracking } from "@/lib/timeStore"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"
import { activeTab, type Tab } from "./tabs"
import { SET_AWAY_PATH, THEMES } from "./UserMenu"
import { StatusChoices, StatusRow } from "./StatusPicker"

const LINKS: { tab: Exclude<Tab, "more">; label: string; to: string; Icon: IconComponent }[] = [
  { tab: "home", label: "Home", to: "/", Icon: House },
  { tab: "chat", label: "Chat", to: "/messages", Icon: MessageCircle },
  { tab: "calendar", label: "Calendar", to: "/calendar", Icon: Calendar },
  { tab: "projects", label: "Projects", to: "/projects", Icon: Projects },
]

const TAB =
  "flex h-full w-full flex-col items-center justify-center gap-0.5 text-micro font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-inset focus-visible:ring-ring"
const ROW =
  "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-body font-medium text-foreground transition-colors duration-150 active:bg-app-sunk focus-visible:bg-app-hover focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-inset focus-visible:ring-ring"
const ROW_ICON = "size-5 shrink-0 text-muted-foreground"
const SEPARATOR = "mx-1 my-1 h-[0.0625rem] bg-border"
const LABEL = "px-3 pb-1 pt-1 text-caption text-muted-foreground"

function TabFace({ Icon, label, active, dot }: { Icon: IconComponent; label: string; active: boolean; dot?: boolean }) {
  return (
    <>
      <span
        className={cn(
          "relative flex h-7 w-12 items-center justify-center rounded-full",
          active && "bg-current-page text-app-pistachio-ink dark:text-app-pistachio",
        )}
      >
        <Icon aria-hidden="true" className="size-5" />
        {dot && <UnreadDot className="absolute top-0.5 right-2.5" />}
      </span>
      <span className="max-w-full truncate px-0.5">{label}</span>
    </>
  )
}

/** The phone's main navigation along the bottom edge, with More for search, settings, the theme and sign out */
export function TabBar() {
  const { pathname } = useLocation()
  const current = activeTab(pathname)
  const unread = useTotalUnread()
  const desktop = useIsDesktop()
  const [moreOpen, setMoreOpen] = useState(false)
  const moreButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (desktop) setMoreOpen(false)
  }, [desktop])

  return (
    <nav
      aria-label="Main"
      data-region="tabbar"
      className="fixed inset-x-0 bottom-0 z-30 h-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] border-t-[0.0625rem] border-border bg-app-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="grid h-full grid-cols-5">
        {LINKS.map(({ tab, label, to, Icon }) => {
          const active = current === tab
          const dot = tab === "chat" && unread
          return (
            <li key={tab} className="min-w-0">
              <Link
                to={to}
                aria-current={active ? "page" : undefined}
                aria-label={dot ? `${label}, unread messages` : undefined}
                className={cn(TAB, active ? "text-foreground" : "text-muted-foreground")}
              >
                <TabFace Icon={Icon} label={label} active={active} dot={dot} />
              </Link>
            </li>
          )
        })}
        <li className="min-w-0">
          <button
            ref={moreButton}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-current={current === "more" ? "page" : undefined}
            onClick={() => setMoreOpen(true)}
            className={cn(TAB, current === "more" ? "text-foreground" : "text-muted-foreground")}
          >
            <TabFace Icon={Ellipsis} label="More" active={current === "more"} />
          </button>
        </li>
      </ul>
      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} returnFocus={() => moreButton.current?.focus()} />
    </nav>
  )
}

function MoreSheet({ open, onOpenChange, returnFocus }: { open: boolean; onOpenChange: (open: boolean) => void; returnFocus: () => void }) {
  const navigate = useNavigate()
  const { open: openCommandMenu } = useCommandMenu()
  const { user, logout } = useAuth()
  const avatarSrc = useAvatarSrc(user?.avatarUrl)
  const { themeMode, setThemeMode } = useDarkMode()
  const themeLabel = useId()
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email || ""
  // Sign out leaves the app, so focus has nowhere to go back to
  const handedOff = useRef(false)
  // Search opens once focus is back on More, so the command menu returns focus there
  const afterClose = useRef<(() => void) | null>(null)
  const [view, setView] = useState<"main" | "status">("main")
  const time = useTimeTracking()
  const body = useRef<HTMLDivElement>(null)
  const switched = useRef(false)

  useEffect(() => {
    if (!open) setView("main")
  }, [open])

  useEffect(() => {
    if (!switched.current) return
    switched.current = false
    const buttons = Array.from(body.current?.querySelectorAll<HTMLElement>("button, a") ?? [])
    ;(buttons.find((button) => button.getAttribute("aria-pressed") === "true") ?? buttons[0])?.focus()
  }, [view])

  const show = (next: "main" | "status") => {
    switched.current = true
    setView(next)
  }

  const close = (then?: () => void) => () => {
    afterClose.current = then ?? null
    onOpenChange(false)
  }

  const goTo = (path: string) => () => {
    navigate(path)
    close()()
  }

  const row = (label: string, icon: ReactNode, onClick: () => void) => (
    <button type="button" className={ROW} onClick={onClick}>
      {icon}
      {label}
    </button>
  )

  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          handedOff.current = false
          afterClose.current = null
        }
        onOpenChange(next)
      }}
      title="More"
      returnFocus={() => {
        if (!handedOff.current) returnFocus()
        handedOff.current = false
        const next = afterClose.current
        afterClose.current = null
        if (next) requestAnimationFrame(next)
      }}
    >
      <div ref={body} className="contents">
        {view === "status" ? (
          <StatusChoices
            variant="sheet"
            itemClass={ROW}
            iconClass={ROW_ICON}
            labelClass={LABEL}
            separator={SEPARATOR}
            onBack={() => show("main")}
          />
        ) : (
          <>
            {time.timer && (
              <div className="px-1 pb-1">
                <TimerClock variant="sheet" />
              </div>
            )}
            {user && (
              <Link to="/settings/profile" onClick={() => close()()} className={cn(ROW, "min-h-14 py-2")}>
                <span aria-hidden="true" className="flex shrink-0">
                  <UserAvatar user={{ id: user.id, first_name: user.firstName, last_name: user.lastName }} src={avatarSrc} size="md" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{fullName}</span>
                  <span className="truncate text-ui font-normal text-muted-foreground">{user.email}</span>
                </span>
              </Link>
            )}
            <div role="separator" className={SEPARATOR} />
            <StatusRow variant="sheet" className={ROW} iconClass={ROW_ICON} onOpen={() => show("status")} />
            {row("Files", <Folder aria-hidden="true" className={ROW_ICON} />, goTo("/files"))}
            {time.enabled && row("Time", <Timer aria-hidden="true" className={ROW_ICON} />, goTo("/time"))}
            {row("Search", <Search aria-hidden="true" className={ROW_ICON} />, close(openCommandMenu))}
            {row("Set out of office", <Away aria-hidden="true" className={ROW_ICON} />, goTo(SET_AWAY_PATH))}
            {row("Settings", <Settings aria-hidden="true" className={ROW_ICON} />, goTo("/settings"))}
            <div role="separator" className={SEPARATOR} />
            <div role="group" aria-labelledby={themeLabel}>
              <p id={themeLabel} className={LABEL}>
                Theme
              </p>
              {THEMES.map(({ value, label, Icon }) => {
                const checked = themeMode === value
                return (
                  <button key={value} type="button" aria-pressed={checked} className={ROW} onClick={() => setThemeMode(value)}>
                    <Icon aria-hidden="true" className={ROW_ICON} />
                    {label}
                    <Check aria-hidden="true" weight="bold" className={cn("ml-auto size-3.5 shrink-0", !checked && "invisible")} />
                  </button>
                )
              })}
            </div>
            <div role="separator" className={SEPARATOR} />
            {row("Sign out", <LogOut aria-hidden="true" className={ROW_ICON} />, () => {
              handedOff.current = true
              onOpenChange(false)
              logout()
            })}
          </>
        )}
      </div>
    </BottomSheet>
  )
}
