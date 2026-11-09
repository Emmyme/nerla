import { useEffect, useId, useRef, useState } from "react"
import type { ComponentType, ReactNode } from "react"
import { Link, useLocation } from "react-router"
import { isTauri } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { useAuth } from "@/providers/AuthProvider"
import { shortcutKeys } from "@/components/call/shortcuts"
import { useCommandMenu } from "@/components/command/registry"
import { useAvatarSrc } from "@/lib/useAvatarSrc"
import { UserAvatar } from "@/components/ui/user-avatar"
import { UserMenu } from "./UserMenu"
import { ShortcutHint } from "@/components/ui/shortcut-hint"
import { ShortcutKeys } from "@/components/ui/shortcut-keys"
import { goToKeys, shortcutCaps } from "@/lib/shortcuts"
import { openShortcuts, useShortcutsOpen } from "@/lib/shortcutsDialog"
import { openWelcome, useOnboarding } from "@/lib/onboarding"
import { rowAction, useRovingList } from "@/lib/useRovingList"
import catLogo from "@/assets/cat-logo.png"
import { setProjectPinned, useProjects } from "@/lib/useProjects"
import { sidebarProjects, useRecentProjects } from "@/lib/recentProjects"
import { useWorkspaceName } from "@/lib/useWorkspaceName"
import { NewProjectDialog } from "@/components/projects/NewProjectDialog"
import type { Project } from "@/lib/api/projects"
import { IdentityTile } from "@/components/ui/identity-tile"
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip"
import {
  House,
  MessageCircle,
  Calendar,
  Projects,
  Folder,
  ChevronDown,
  Pin,
  Plus,
  Search,
  SidebarToggle,
  Sparkle,
  Timer,
  Trash,
} from "@/components/icons"
import { useMediaQuery } from "@/lib/useMediaQuery"
import { UnreadDot } from "@/components/ui/unread-dot"
import { useTotalUnread } from "@/lib/chatHooks"
import { Collapse } from "@/components/ui/collapse"
import { TimerClock } from "@/components/time/TimerClock"
import { useTimeTracking } from "@/lib/timeStore"

const COLLAPSED_KEY = "nerla-sidebar-collapsed"
const COLLAPSED_NARROW_KEY = "nerla-sidebar-collapsed-narrow"
const NARROW_QUERY = "(max-width: 89.99rem)"
const PROJECTS_OPEN_KEY = "nerla-sidebar-projects-open"
// Pinned first, then the most recent, and All projects for the rest
const MAX_PROJECTS = 4
// The newest pin first, so a pin made anywhere always shows. The project's id settles the order when two pins share a time
const pinOrder = (a: Project, b: Project) => (b.pinned_at ?? "").localeCompare(a.pinned_at ?? "") || a.id.localeCompare(b.id)

function readFlag(key: string, fallback: boolean) {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value === "true"
  } catch {
    return fallback
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    return
  }
}

function usePersistedFlag(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => readFlag(key, fallback))
  const update = (next: boolean) => {
    setValue(next)
    writeFlag(key, next)
  }
  return [value, update] as const
}

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
// One left padding in both widths, so the icons hold still while the rail eases
const rowBase = `flex items-center gap-2 rounded-md py-1 pr-2 text-body transition-colors ${focusRing}`
const itemBase = `${rowBase} pl-2.75`
const itemIdle = "text-muted-foreground hover:bg-app-hover hover:text-foreground"
const itemActive = "bg-current-page text-app-pistachio-ink font-medium dark:text-foreground dark:[&_svg]:text-app-pistachio"
const iconButtonBase = `inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-app-hover ${focusRing}`
// Shown on hover and keyboard focus within the row, and always on touch screens
const revealed =
  "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"

type IconType = ComponentType<{ size?: number | string; className?: string }>

export default function Sidebar() {
  const { pathname } = useLocation()
  const { user } = useAuth()
  const { open: openCommandMenu } = useCommandMenu()

  // Narrow windows start minimized and remember their own choice
  const narrow = useMediaQuery(NARROW_QUERY, false)
  const [wideCollapsed, setWideCollapsed] = usePersistedFlag(COLLAPSED_KEY, false)
  const [narrowCollapsed, setNarrowCollapsed] = usePersistedFlag(COLLAPSED_NARROW_KEY, true)
  const collapsed = narrow ? narrowCollapsed : wideCollapsed
  const setCollapsed = narrow ? setNarrowCollapsed : setWideCollapsed
  const [projectsOpen, setProjectsOpen] = usePersistedFlag(PROJECTS_OPEN_KEY, true)
  const { projects, status: projectsStatus, refresh: refreshProjects } = useProjects()
  const recentIds = useRecentProjects()
  const workspaceName = useWorkspaceName()
  const [creating, setCreating] = useState(false)
  const projectListId = useId()
  const chatUnread = useTotalUnread()
  const time = useTimeTracking()
  const avatarSrc = useAvatarSrc(user?.avatarUrl)
  const [menuOpen, setMenuOpen] = useState(false)
  const userButton = useRef<HTMLButtonElement>(null)
  // A press on the row while the menu is open closes it as a press outside, so the click must not reopen it
  const wasOpen = useRef<boolean | null>(null)
  const collapseButton = useRef<HTMLButtonElement>(null)
  const expandButton = useRef<HTMLButtonElement>(null)
  // The pressed toggle goes away, so focus moves to the one that takes its place
  const toggled = useRef(false)
  useEffect(() => {
    if (!toggled.current) return
    toggled.current = false
    ;(collapsed ? expandButton : collapseButton).current?.focus()
  }, [collapsed])
  const toggleCollapsed = (next: boolean) => {
    toggled.current = true
    setCollapsed(next)
  }

  // On the desktop build the logo row moves the window, so the sidebar needs no title strip of its own
  const tauri = isTauri()
  const noDrag = tauri ? "app-region-no-drag" : ""

  const isCurrent = (route: string) => (route === "/" ? pathname === "/" : pathname === route || pathname.startsWith(`${route}/`))

  // Always wrapped, so the rows stay mounted and their labels can fade. Tips only show on the rail
  const withTip = (text: string, node: ReactNode, keys?: string[][]) => (
    <Tooltip {...(collapsed ? {} : { open: false })}>
      <TooltipTrigger asChild>{node}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className={keys ? "flex items-center gap-2" : undefined}>
        {text}
        {keys && <ShortcutKeys keys={keys} hintClassName="border-background/30 text-background/75" wordClassName="text-background/75" />}
      </TooltipContent>
    </Tooltip>
  )

  const iconButton = `${iconButtonBase} size-[1.5rem]`
  const rowHeight = "min-h-[1.75rem]"

  const itemClass = (active: boolean) => `${itemBase} ${rowHeight} ${active ? itemActive : itemIdle}`

  // Labels stay in the row and fade, so they never wrap while the width eases
  const fade = `motion-fade ${collapsed ? "opacity-0" : "opacity-100"}`
  const text = (value: string) => <span className={`overflow-hidden whitespace-nowrap ${fade}`}>{value}</span>

  const onProjectPage = pathname.startsWith("/project/")

  const navLink = (name: string, route: string, Icon: IconType, alsoActive = false, dot = false) => {
    const active = isCurrent(route) || alsoActive
    return withTip(
      name,
      <Link to={route} aria-current={active ? "page" : undefined} {...nav.item(route)} className={itemClass(active)}>
        <span className="relative flex shrink-0">
          <Icon size={17} className="shrink-0" />
          {dot && collapsed && <UnreadDot className="absolute -top-1 -right-1" />}
        </span>
        {text(name)}
        {dot &&
          (collapsed ? (
            <span className="sr-only">, unread messages</span>
          ) : (
            <UnreadDot label="Unread messages" className="ml-auto pr-0.5" />
          ))}
      </Link>,
      goToKeys(route),
    )
  }

  const pinnedIds = projects
    .filter((project) => project.pinned)
    .sort(pinOrder)
    .map((project) => project.id)
  const listed = sidebarProjects(projects, pinnedIds, recentIds, Math.max(0, MAX_PROJECTS - pinnedIds.length))
  const pinned = listed.pinned.slice(0, MAX_PROJECTS)
  const others = listed.others
  const shown = [...pinned, ...others]

  // The navigation list is one Tab stop, and lands on the current page
  const listOpen = projectsOpen && !collapsed
  const listKeys =
    projectsStatus === "error" && shown.length === 0
      ? ["retry"]
      : projectsStatus === "ready" && shown.length === 0
        ? ["all-projects"]
        : [...shown.map((project) => project.id), ...(shown.length > 0 ? ["all-projects"] : [])]
  const navKeys = [
    "/",
    "/messages",
    "/calendar",
    "/files",
    ...(time.enabled ? ["/time"] : []),
    collapsed ? "/projects" : "projects-toggle",
    ...(listOpen ? listKeys : []),
  ]
  const projectHere = shown.find((project) => isCurrent(`/project/${project.slug}`))
  const sectionKey = () => {
    if (collapsed) return onProjectPage || isCurrent("/projects") ? "/projects" : null
    if (listOpen && projectHere) return projectHere.id
    if (listOpen && isCurrent("/projects")) return "all-projects"
    return onProjectPage ? "projects-toggle" : null
  }
  const currentKey = navKeys.find((key) => key.startsWith("/") && key !== "/projects" && isCurrent(key)) ?? sectionKey()
  const nav = useRovingList(navKeys, currentKey)
  const shortcutsOpen = useShortcutsOpen()
  const trashActive = isCurrent("/trash")
  const tools = useRovingList(["/trash", "shortcuts", "welcome"], trashActive ? "/trash" : null)
  const welcomeOpen = useOnboarding().welcomeOpen
  const shortcutsKey = shortcutCaps("shortcuts") ?? "?"

  // A row that leaves the list as it is pinned or unpinned hands focus to the row after it, or to Projects
  const leaving = useRef<{ id: string; index: number } | null>(null)
  useEffect(() => {
    const left = leaving.current
    if (!left) return
    leaving.current = null
    if (shown.some((project) => project.id === left.id)) return
    const active = document.activeElement
    if (active && active !== document.body) return
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="sidebar-project"]'))
    ;(rows[left.index] ?? rows[left.index - 1] ?? document.querySelector<HTMLElement>('[data-roving-item="projects-toggle"]'))?.focus()
  })

  const togglePin = (project: Project) => {
    leaving.current = { id: project.id, index: shown.indexOf(project) }
    const next = !project.pinned
    setProjectPinned(project, next).catch(() => {
      toast.error(next ? `Couldn't pin ${project.name}` : `Couldn't unpin ${project.name}`)
    })
  }

  const projectRow = (project: Project, gapBefore: boolean) => {
    const route = `/project/${project.slug}`
    const active = isCurrent(route)
    const isPinned = !!project.pinned
    return (
      <div key={project.id} data-roving-row="" className={`group/row relative ${gapBefore ? "mt-1.5" : ""}`}>
        <Link
          to={route}
          {...nav.item(project.id)}
          title={project.name}
          data-testid="sidebar-project"
          aria-current={active ? "page" : undefined}
          className={`${itemBase} ${rowHeight} pr-8 ${active ? itemActive : `${itemIdle} group-hover/row:bg-app-hover group-hover/row:text-foreground`}`}
        >
          <IdentityTile color={project.color} symbol={project.icon} size="sm" />
          <span className="truncate">{project.name}</span>
        </Link>
        <button
          type="button"
          aria-label={isPinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
          onClick={() => togglePin(project)}
          {...rowAction}
          className={`${iconButton} absolute top-1/2 right-0.5 -translate-y-1/2 hover:text-foreground ${revealed}`}
        >
          <Pin aria-hidden="true" weight={isPinned ? "fill" : "regular"} className="size-[0.875rem]" />
        </button>
      </div>
    )
  }
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email || ""
  const settingsActive = isCurrent("/settings")
  const profileName = [fullName, workspaceName].filter(Boolean).join(", ")

  return (
    <TooltipProvider delayDuration={150}>
      <div
        data-open={collapsed ? undefined : ""}
        className={`motion-size flex h-full flex-col overflow-hidden border-r border-border bg-background ${collapsed ? "w-[4rem]" : "w-[15rem]"}`}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto px-3 py-3.5">
          <div
            data-tauri-drag-region={tauri || undefined}
            className={`relative flex items-center justify-center px-2 py-1.5 ${tauri ? "app-region-drag pointer-events-auto select-none" : ""}`}
          >
            <img
              src={catLogo}
              alt="Nerla"
              title={collapsed ? "Nerla" : undefined}
              data-open={collapsed ? undefined : ""}
              className={`h-[1.6rem] w-auto max-w-none shrink-0 ${noDrag}`}
            />
            {!collapsed && (
              <button
                ref={collapseButton}
                type="button"
                aria-label="Collapse sidebar"
                onClick={() => toggleCollapsed(true)}
                className={`${iconButton} motion-panel absolute top-1/2 right-[0.45rem] -translate-y-1/2 animate-in fade-in-0 ${noDrag}`}
              >
                <SidebarToggle aria-hidden="true" className="size-[1.15rem]" />
              </button>
            )}
          </div>
          <Collapse open={collapsed} className="flex justify-center">
            <button
              ref={expandButton}
              type="button"
              aria-label="Expand sidebar"
              onClick={() => toggleCollapsed(false)}
              className={`${iconButton} mb-1 ${noDrag}`}
            >
              <SidebarToggle aria-hidden="true" className="size-[1.15rem]" />
            </button>
          </Collapse>

          {withTip(
            "Search or jump to",
            <button
              type="button"
              aria-label={collapsed ? "Search or jump to" : undefined}
              onClick={openCommandMenu}
              className={`mt-2 mb-2.5 flex ${rowHeight} items-center gap-2 rounded-md border border-border bg-app-surface py-1 pr-2 pl-2.5 text-ui text-muted-foreground hover:bg-app-hover ${focusRing}`}
            >
              <Search size={17} className="shrink-0" />
              <span className={`flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap ${fade}`}>
                <span className="truncate">Search or jump to</span>
                <ShortcutHint variant="outline" keys={shortcutKeys("K")} className="ml-auto shrink-0" />
              </span>
            </button>,
          )}

          <nav aria-label="Primary" {...nav.list} className="flex flex-col gap-0.5">
            {navLink("Home", "/", House)}
            {navLink("Chat", "/messages", MessageCircle, false, chatUnread)}
            {navLink("Calendar", "/calendar", Calendar)}
            {navLink("Files", "/files", Folder)}
            {time.enabled && navLink("Time", "/time", Timer)}

            <div className="mt-4 flex flex-col gap-0.5">
              {collapsed ? (
                navLink("Projects", "/projects", Projects, onProjectPage)
              ) : (
                <div data-roving-row="" className="group/row relative">
                  <button
                    type="button"
                    {...nav.item("projects-toggle")}
                    aria-expanded={projectsOpen}
                    aria-controls={projectListId}
                    onClick={() => setProjectsOpen(!projectsOpen)}
                    className={`flex ${rowHeight} w-full items-center gap-1 rounded-md py-1 pr-8 pl-2.75 text-left text-ui font-medium transition-colors ${focusRing} ${
                      !projectsOpen && onProjectPage ? itemActive : "text-muted-foreground hover:bg-app-hover hover:text-foreground"
                    }`}
                  >
                    Projects
                    <ChevronDown size={12} aria-hidden="true" className={`motion-rotate shrink-0 ${projectsOpen ? "" : "-rotate-90"}`} />
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="New project"
                        onClick={() => setCreating(true)}
                        {...rowAction}
                        className={`${iconButton} absolute top-1/2 right-0.5 -translate-y-1/2 hover:text-foreground ${revealed}`}
                      >
                        <Plus aria-hidden="true" className="size-[0.875rem]" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8} className="flex items-center gap-2">
                      New project
                      <ShortcutHint keys="C" variant="outline" className="border-background/30 text-background/75" />
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}
              <Collapse open={projectsOpen && !collapsed} id={projectListId} className="flex flex-col gap-0.5">
                {projectsStatus === "error" && shown.length === 0 && (
                  <>
                    <p className="py-1 pr-2 pl-2.75 text-ui text-muted-foreground">Couldn't load projects</p>
                    <button
                      type="button"
                      onClick={refreshProjects}
                      {...nav.item("retry")}
                      className={`flex ${rowHeight} items-center rounded-md py-1 pr-2 pl-2.75 text-left text-ui ${itemIdle} ${focusRing}`}
                    >
                      Try again
                    </button>
                  </>
                )}
                {projectsStatus === "ready" && shown.length === 0 && (
                  <>
                    <p className="py-1 pr-2 pl-2.75 text-ui text-muted-foreground">You're not in any projects yet</p>
                    <Link
                      to="/projects"
                      {...nav.item("all-projects")}
                      className={`flex ${rowHeight} items-center rounded-md py-1 pr-2 pl-2.75 text-ui ${itemIdle} ${focusRing}`}
                    >
                      All projects
                    </Link>
                  </>
                )}
                {shown.map((project, index) => projectRow(project, index > 0 && index === pinned.length))}
                {shown.length > 0 && (
                  <Link
                    to="/projects"
                    {...nav.item("all-projects")}
                    aria-current={isCurrent("/projects") ? "page" : undefined}
                    className={`${itemBase} ${rowHeight} ${isCurrent("/projects") ? itemActive : itemIdle}`}
                  >
                    <span aria-hidden="true" className="w-[1.0625rem] shrink-0" />
                    All projects
                  </Link>
                )}
              </Collapse>
            </div>
          </nav>
          <NewProjectDialog open={creating} onOpenChange={setCreating} />

          <div className="mt-auto pt-3">
            <div {...tools.list} className="flex flex-col gap-0.5 pb-2">
              {withTip(
                "Trash",
                <Link
                  to="/trash"
                  aria-current={trashActive ? "page" : undefined}
                  {...tools.item("/trash")}
                  className={itemClass(trashActive)}
                >
                  <Trash size={17} className="shrink-0" />
                  {text("Trash")}
                </Link>,
                goToKeys("/trash"),
              )}
              {withTip(
                "Keyboard shortcuts",
                <button
                  type="button"
                  {...tools.item("shortcuts")}
                  aria-label={collapsed ? "Keyboard shortcuts" : undefined}
                  aria-haspopup="dialog"
                  aria-expanded={shortcutsOpen}
                  aria-keyshortcuts="?"
                  onClick={() => openShortcuts()}
                  className={`${itemClass(false)} w-full text-left`}
                >
                  {collapsed && (
                    <span className="flex w-[1.0625rem] shrink-0 justify-center">
                      <ShortcutHint variant="outline" keys={shortcutsKey} />
                    </span>
                  )}
                  <span className={`flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap ${fade}`}>
                    <span className="truncate">Keyboard shortcuts</span>
                    <ShortcutHint variant="outline" keys={shortcutsKey} className="ml-auto shrink-0" />
                  </span>
                </button>,
              )}
              {withTip(
                "Welcome tour",
                <button
                  type="button"
                  {...tools.item("welcome")}
                  aria-haspopup="dialog"
                  aria-expanded={welcomeOpen}
                  onClick={openWelcome}
                  className={`${itemClass(false)} w-full text-left`}
                >
                  <Sparkle size={17} className="shrink-0" />
                  {text("Welcome tour")}
                </button>,
              )}
            </div>
            {time.timer && (
              <div className="pb-2">
                <TimerClock variant={collapsed ? "rail" : "row"} />
              </div>
            )}
            <div className="border-t border-border pt-2">
              {user &&
                withTip(
                  profileName,
                  <button
                    ref={userButton}
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-label={collapsed ? profileName : undefined}
                    onPointerDown={() => {
                      wasOpen.current = menuOpen
                    }}
                    onClick={() => {
                      const was = wasOpen.current ?? menuOpen
                      wasOpen.current = null
                      setMenuOpen(!was)
                    }}
                    className={`${rowBase} w-full pl-1 ${settingsActive ? itemActive : itemIdle} ${menuOpen && !settingsActive ? "bg-app-hover" : ""} text-left`}
                  >
                    <span aria-hidden="true" className="flex shrink-0">
                      <UserAvatar
                        user={{ id: user.id, first_name: user.firstName, last_name: user.lastName }}
                        src={avatarSrc}
                        size={collapsed ? "md" : "lg"}
                        catSize={collapsed ? "md" : "base"}
                        presence="own"
                      />
                    </span>
                    <span className={`flex min-w-0 flex-col leading-tight whitespace-nowrap ${fade}`}>
                      <span className={`truncate ${settingsActive ? "" : "text-foreground"}`}>{fullName}</span>
                      {workspaceName && (
                        <span
                          title={workspaceName}
                          data-testid="workspace-name"
                          className={`truncate text-caption font-normal ${settingsActive ? "text-app-pistachio-ink dark:text-muted-foreground" : "text-muted-foreground"}`}
                        >
                          {workspaceName}
                        </span>
                      )}
                    </span>
                  </button>,
                )}
              <UserMenu
                open={menuOpen}
                onOpenChange={setMenuOpen}
                anchor={menuOpen ? userButton.current : null}
                side={collapsed ? "right" : "bottom"}
                returnFocus={() => userButton.current?.focus()}
              />
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
