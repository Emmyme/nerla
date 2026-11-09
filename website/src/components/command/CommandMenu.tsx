import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { useNavigate } from "react-router"
import * as Dialog from "@radix-ui/react-dialog"
import { Command as Cmdk } from "cmdk"
import { useProjects } from "@/lib/useProjects"
import { useDarkMode, type ThemeModePreference } from "@/contexts/DarkModeContext"
import { settingsSections } from "@/components/settings/settingsSections"
import { aiVisibleOf, useAiAccess } from "@/lib/aiAccess"
import { useAuth } from "@/providers/AuthProvider"
import { useCommandMenu, useRegisteredCommands, type Command } from "./registry"
import { SearchResultHost, useSearchResultHost } from "./SearchResultHost"
import { ShortcutHint } from "@/components/ui/shortcut-hint"
import { CatSearching } from "@/components/ui/cat-scenes"
import { IdentityTile } from "@/components/ui/identity-tile"
import { StatusIcon } from "@/components/ui/status-icon"
import { searchAPI, type SearchReply } from "@/lib/api/search"
import { docRoute } from "@/components/files/fileKinds"
import { messagePath } from "@/lib/chatDock"
import { formatShortDate, formatTime, parseDueDate, parseServerDate, toDueDateValue } from "@/lib/dates"
import { FADE_MOTION } from "@/lib/motion"
import { keepToasts } from "@/lib/utils"
import { shortcutCaps } from "@/lib/shortcuts"
import { openShortcuts } from "@/lib/shortcutsDialog"
import { openWelcome } from "@/lib/onboarding"
import { runFromMenu } from "@/lib/dialogOpener"
import { STATUS_LABEL } from "@/types/tasks"

const GROUPS: Command["group"][] = ["Navigate", "Projects", "Actions"]
const THEMES: { mode: ThemeModePreference; label: string }[] = [
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
  { mode: "system", label: "System" },
]
const MIN_QUERY = 2
const MAX_QUERY = 100
const DEBOUNCE_MS = 200

const GROUP_CLASS =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-muted-foreground"
const ITEM_CLASS =
  "group flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-ui text-foreground max-lg:min-h-11 data-[selected=true]:bg-current-page data-[selected=true]:text-app-pistachio-ink dark:data-[selected=true]:text-foreground data-[disabled=true]:cursor-default data-[disabled=true]:opacity-60"
const META_CLASS =
  "truncate text-caption text-muted-foreground group-data-[selected=true]:text-current dark:group-data-[selected=true]:text-muted-foreground"
const NOTE_CLASS = "px-5 pb-3 pt-1 text-caption text-muted-foreground"
const SEARCHING = "Searching…"

function score(search: string, keywords: string[] = []) {
  const q = search.trim().toLowerCase()
  if (!q) return 1
  const [title = "", ...rest] = keywords.map((k) => k.toLowerCase())
  if (title.startsWith(q)) return 1
  const words = title.split(/\s+/)
  const tiers = q.split(/\s+/).map((token) => {
    if (words.some((w) => w.startsWith(token))) return 0.8
    if (title.includes(token)) return 0.6
    if (rest.some((k) => k.includes(token))) return 0.3
    return 0
  })
  return Math.min(...tiers)
}

/** Matching commands, best first within each group, and the group with the best match first */
function filterCommands(commands: Command[], search: string): { group: Command["group"]; items: Command[] }[] {
  const scored = commands
    .map((command) => ({ command, score: score(search, [command.title, ...(command.keywords ?? [])]) }))
    .filter((entry) => entry.score > 0)
  return GROUPS.map((group) => {
    const entries = scored.filter((entry) => entry.command.group === group).sort((a, b) => b.score - a.score)
    return { group, items: entries.map((entry) => entry.command), best: entries[0]?.score ?? 0 }
  })
    .filter((entry) => entry.items.length > 0)
    .sort((a, b) => (search.trim() ? b.best - a.best : 0))
}

/** The text the server gets: trimmed, and cut to its limit without splitting a character */
function searchText(query: string): string {
  let q = query.trim()
  if (q.length > MAX_QUERY) q = q.slice(0, /[\uD800-\uDBFF]/.test(q[MAX_QUERY - 1]) ? MAX_QUERY - 1 : MAX_QUERY).trim()
  return q
}

/** `replyQ` is the query the reply answers, which lags `q` while the next one loads */
type SearchState = { status: "idle" | "loading" | "ready" | "error"; reply: SearchReply | null; replyQ: string }

/** Waits for a pause in typing, and each new query aborts the request before it */
function useSearch(q: string): SearchState {
  const searchable = Array.from(q).length >= MIN_QUERY
  const [state, setState] = useState<SearchState>({ status: "idle", reply: null, replyQ: "" })

  useEffect(() => {
    if (!searchable) {
      setState({ status: "idle", reply: null, replyQ: "" })
      return
    }
    // The last answer stays up while the next one loads, so the list does not jump on every key
    setState((shown) => ({ ...shown, status: "loading" }))
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchAPI
        .search(q, controller.signal)
        .then((reply) => !controller.signal.aborted && setState({ status: "ready", reply, replyQ: q }))
        .catch(() => !controller.signal.aborted && setState({ status: "error", reply: null, replyQ: q }))
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [q, searchable])

  return state
}

const eventDate = (event: SearchReply["events"]["items"][number]) =>
  event.allDay ? parseDueDate(event.startsAt) : parseServerDate(event.startsAt)

function eventWhen(event: SearchReply["events"]["items"][number]): string {
  const date = eventDate(event)
  if (!date) return ""
  return event.allDay ? `${formatShortDate(date)}, all day` : `${formatShortDate(date)}, ${formatTime(date)}`
}

function Row({ title, meta, aside, lead }: { title: ReactNode; meta?: ReactNode; aside?: ReactNode; lead?: ReactNode }) {
  return (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        {lead}
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{title}</span>
          {meta && <span className={META_CLASS}>{meta}</span>}
        </span>
      </span>
      {aside && <span className={`shrink-0 ${META_CLASS}`}>{aside}</span>}
    </>
  )
}

export default function CommandMenu() {
  return (
    <SearchResultHost>
      <Menu />
    </SearchResultHost>
  )
}

function Menu() {
  const { isOpen, open, close } = useCommandMenu()
  const registered = useRegisteredCommands()
  const navigate = useNavigate()
  const { setThemeMode } = useDarkMode()
  const { user, logout } = useAuth()
  const { projects } = useProjects()
  const host = useSearchResultHost()
  // The account role mirrors the workspace role, which the server keeps in step on every role change
  const isAdmin = user?.role === "admin"
  const aiVisible = aiVisibleOf(useAiAccess(isOpen).me)
  const [query, setQuery] = useState("")
  const q = searchText(query)
  const search = useSearch(isOpen ? q : "")
  const opener = useRef<HTMLElement | null>(null)
  // Enter pressed before the answer came, with no command to take it, opens the first result when it lands
  const pendingEnter = useRef<string | null>(null)

  // Runs before the menu takes focus, so it still sees what opened it
  useLayoutEffect(() => {
    if (!isOpen) return
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null
    pendingEnter.current = null
    setQuery("")
  }, [isOpen])

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => navigate(path)
    return [
      { id: "nav-home", title: "Home", group: "Navigate", shortcut: shortcutCaps("goto.h"), run: go("/") },
      { id: "nav-chat", title: "Chat", group: "Navigate", shortcut: shortcutCaps("goto.c"), keywords: ["messages"], run: go("/messages") },
      { id: "nav-calendar", title: "Calendar", group: "Navigate", shortcut: shortcutCaps("goto.a"), run: go("/calendar") },
      {
        id: "nav-files",
        title: "Files",
        group: "Navigate",
        shortcut: shortcutCaps("goto.f"),
        keywords: ["papers", "boards", "documents"],
        run: go("/files"),
      },
      { id: "nav-projects", title: "Projects", group: "Navigate", shortcut: shortcutCaps("goto.p"), run: go("/projects") },
      {
        id: "nav-settings",
        title: "Settings",
        group: "Navigate",
        shortcut: shortcutCaps("goto.s"),
        keywords: ["preferences", "account"],
        run: go("/settings"),
      },
      {
        id: "nav-trash",
        title: "Trash",
        group: "Navigate",
        shortcut: shortcutCaps("goto.x"),
        keywords: ["deleted", "restore", "bin"],
        run: go("/trash"),
      },
      {
        id: "action-shortcuts",
        title: "Keyboard shortcuts",
        group: "Actions",
        shortcut: shortcutCaps("shortcuts"),
        keywords: ["keys", "hotkeys", "help"],
        run: () => runFromMenu(opener.current, openShortcuts),
      },
      {
        id: "action-welcome",
        title: "Welcome tour",
        group: "Actions",
        keywords: ["help", "getting started", "intro", "tour"],
        run: () => runFromMenu(opener.current, openWelcome),
      },
      ...settingsSections({ isAdmin, aiVisible }).map<Command>((section) => ({
        id: `settings-${section.id}`,
        title: section.label,
        group: "Navigate",
        keywords: ["settings"],
        run: go(section.path),
      })),
      ...projects.map<Command>((p) => ({
        id: `project-${p.id}`,
        title: p.name,
        group: "Projects",
        lead: <IdentityTile color={p.color} symbol={p.icon} size="sm" />,
        run: go(`/project/${p.slug}`),
      })),
      ...THEMES.map<Command>(({ mode, label }) => ({
        id: `action-theme-${mode}`,
        title: `Theme: ${label}`,
        group: "Actions",
        keywords: ["appearance", "dark mode", "light mode"],
        run: () => setThemeMode(mode),
      })),
      ...registered,
      { id: "action-sign-out", title: "Sign out", group: "Actions", keywords: ["log out"], run: logout },
    ]
  }, [projects, registered, navigate, setThemeMode, isAdmin, aiVisible, logout])

  const local = useMemo(() => filterCommands(commands, query), [commands, query])
  const reply = search.status === "idle" ? null : search.reply
  // Rows of an earlier query stay in view while the next answer loads, but cannot be chosen
  const stale = !!reply && search.replyQ !== q
  const waiting = search.status === "loading" || stale
  // Projects already listed by the menu show once, in its own Projects group
  const listed = new Set(local.flatMap((group) => group.items.map((c) => c.id)))
  const projectHits = (reply?.projects.items ?? []).filter((p) => !listed.has(`project-${p.id}`))
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))
  const serverCount = reply
    ? reply.files.items.length +
      reply.tasks.items.length +
      projectHits.length +
      reply.people.items.length +
      reply.messages.items.length +
      reply.events.items.length
    : 0

  const pick = (run: () => void) => () => {
    close()
    run()
  }

  const go = {
    file: (file: SearchReply["files"]["items"][number]) => () => {
      const route = docRoute(file)
      if (route) navigate(route)
      else host.openFile(file, opener.current)
    },
    task: (task: SearchReply["tasks"]["items"][number]) => () =>
      navigate(task.project ? `/project/${task.project.slug}?task=${task.id}` : `/?task=${task.id}`),
    project: (project: SearchReply["projects"]["items"][number]) => () => navigate(`/project/${project.slug}`),
    person: (person: SearchReply["people"]["items"][number]) => () =>
      host.openPerson({ id: person.id, first_name: person.name, avatar_url: person.avatarUrl }, opener.current),
    message: (message: SearchReply["messages"]["items"][number]) => () => navigate(messagePath(message.chat, message.id)),
    event: (event: SearchReply["events"]["items"][number]) => () => {
      const day = toDueDateValue(eventDate(event) ?? new Date())
      const params = new URLSearchParams({ event: event.id, date: day ?? "", owner: event.ownerId, type: event.eventType })
      navigate(`/calendar?${params}`)
    },
  }

  // The first row in the order the groups show
  const firstResult = (): (() => void) | null => {
    if (!reply) return null
    const file = reply.files.items[0]
    if (file) return go.file(file)
    const task = reply.tasks.items[0]
    if (task) return go.task(task)
    if (projectHits[0]) return go.project(projectHits[0])
    const person = reply.people.items[0]
    if (person) return go.person(person)
    const message = reply.messages.items[0]
    if (message) return go.message(message)
    const event = reply.events.items[0]
    return event ? go.event(event) : null
  }

  const latestFirst = useRef(firstResult)
  latestFirst.current = firstResult
  useEffect(() => {
    const wanted = pendingEnter.current
    if (wanted === null || search.status === "loading") return
    pendingEnter.current = null
    if (search.status !== "ready" || search.replyQ !== wanted) return
    const run = latestFirst.current()
    if (run) pick(run)()
  })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || !waiting) return
    const selected = event.currentTarget.querySelector('[cmdk-item][aria-selected="true"]')
    if (selected && selected.getAttribute("aria-disabled") !== "true") return
    event.preventDefault()
    const command = local[0]?.items[0]
    if (command) pick(command.run)()
    else pendingEnter.current = q
  }

  const projectItem = (p: SearchReply["projects"]["items"][number]) => (
    <Cmdk.Item key={p.id} value={`search-project-${p.id}`} disabled={stale} onSelect={pick(go.project(p))} className={ITEM_CLASS}>
      <Row lead={<IdentityTile color={p.color} symbol={p.icon} size="sm" />} title={p.name} />
    </Cmdk.Item>
  )

  const serverGroup = (heading: string, count: number, children: ReactNode) =>
    count > 0 && (
      <Cmdk.Group key={heading} heading={heading} className={GROUP_CLASS}>
        {children}
      </Cmdk.Group>
    )

  let note = ""
  if (search.status === "error") note = "Search is unavailable right now"
  else if (waiting) note = SEARCHING
  else if (local.length === 0 && serverCount === 0) note = q ? `Nothing found for “${q}”` : "No results"
  const nothingFound = search.status !== "error" && !waiting && local.length === 0 && serverCount === 0 && q !== ""

  return (
    // cmdk's own dialog doesn't pass onInteractOutside on, so the Radix dialog it builds on is used directly and a toast
    // can be clicked without closing the menu
    <Dialog.Root open={isOpen} onOpenChange={(next) => (next ? open() : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className={`fixed inset-0 z-50 bg-app-scrim ${FADE_MOTION}`} />
        <Dialog.Content
          aria-describedby={undefined}
          onInteractOutside={keepToasts}
          className={`fixed top-[15vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-popover)] ${FADE_MOTION} motion-safe:data-[state=closed]:zoom-out-[0.98] motion-safe:data-[state=open]:slide-in-from-top-2 motion-safe:data-[state=open]:zoom-in-[0.98]`}
        >
          <Dialog.Title className="sr-only">Command menu</Dialog.Title>
          <Cmdk label="Command menu" shouldFilter={false} onKeyDown={onKeyDown}>
            <Cmdk.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Type a command or search"
              className="w-full border-b border-border bg-transparent px-4 py-3 text-ui text-foreground outline-none placeholder:text-muted-foreground"
            />
            <Cmdk.List className="max-h-[22rem] overflow-auto p-2">
              {local.map(({ group, items }) => (
                <Cmdk.Group key={group} heading={group} className={GROUP_CLASS}>
                  {items.map((c) => (
                    <Cmdk.Item key={c.id} value={c.id} onSelect={pick(c.run)} className={ITEM_CLASS}>
                      {c.lead ? <Row lead={c.lead} title={c.title} /> : <span>{c.title}</span>}
                      {c.shortcut && (
                        <ShortcutHint
                          variant="outline"
                          keys={c.shortcut}
                          className="group-data-[selected=true]:border-app-pistachio-ink/30 group-data-[selected=true]:text-app-pistachio-ink dark:group-data-[selected=true]:border-input dark:group-data-[selected=true]:text-foreground"
                        />
                      )}
                    </Cmdk.Item>
                  ))}
                  {group === "Projects" && projectHits.map(projectItem)}
                </Cmdk.Group>
              ))}
              {reply && (
                <>
                  {serverGroup(
                    "Files",
                    reply.files.items.length,
                    <>
                      {reply.files.items.map((file) => (
                        <Cmdk.Item
                          key={file.id}
                          value={`search-file-${file.id}`}
                          disabled={stale}
                          onSelect={pick(go.file(file))}
                          className={ITEM_CLASS}
                        >
                          <Row
                            title={file.name}
                            meta={
                              file.context?.where ?? (file.projectId ? (projectNames.get(file.projectId) ?? "Project files") : "My files")
                            }
                          />
                        </Cmdk.Item>
                      ))}
                      {reply.files.more && (
                        <Cmdk.Item
                          value="search-files-more"
                          disabled={stale}
                          onSelect={pick(() => navigate(`/files?q=${encodeURIComponent(search.replyQ)}`))}
                          className={ITEM_CLASS}
                        >
                          <span className="text-muted-foreground group-data-[selected=true]:text-current">Show more files</span>
                        </Cmdk.Item>
                      )}
                    </>,
                  )}
                  {serverGroup(
                    "Tasks",
                    reply.tasks.items.length,
                    reply.tasks.items.map((task) => (
                      <Cmdk.Item
                        key={task.id}
                        value={`search-task-${task.id}`}
                        disabled={stale}
                        onSelect={pick(go.task(task))}
                        className={ITEM_CLASS}
                      >
                        <Row
                          lead={<StatusIcon status={task.status} className="size-3.5" />}
                          title={
                            task.identifier ? (
                              <>
                                <span className="mr-2 text-muted-foreground group-data-[selected=true]:text-current">
                                  {task.identifier}
                                </span>
                                {task.title}
                              </>
                            ) : (
                              task.title
                            )
                          }
                          meta={`${task.project?.name ?? "Personal task"} · ${STATUS_LABEL[task.status] ?? task.status.replace(/_/g, " ")}`}
                        />
                      </Cmdk.Item>
                    )),
                  )}
                  {!local.some((g) => g.group === "Projects") && serverGroup("Projects", projectHits.length, projectHits.map(projectItem))}
                  {serverGroup(
                    "People",
                    reply.people.items.length,
                    reply.people.items.map((person) => (
                      <Cmdk.Item
                        key={person.id}
                        value={`search-person-${person.id}`}
                        disabled={stale}
                        onSelect={pick(go.person(person))}
                        className={ITEM_CLASS}
                      >
                        <Row title={person.name} meta={[person.jobTitle, person.team].filter(Boolean).join(" · ") || undefined} />
                      </Cmdk.Item>
                    )),
                  )}
                  {serverGroup(
                    "Messages",
                    reply.messages.items.length,
                    reply.messages.items.map((message) => (
                      <Cmdk.Item
                        key={message.id}
                        value={`search-message-${message.id}`}
                        disabled={stale}
                        onSelect={pick(go.message(message))}
                        className={ITEM_CLASS}
                      >
                        <Row
                          title={message.snippet}
                          meta={`${message.sender?.name ?? "Someone"} in ${message.chat.title}`}
                          aside={formatShortDate(message.createdAt)}
                        />
                      </Cmdk.Item>
                    )),
                  )}
                  {serverGroup(
                    "Events",
                    reply.events.items.length,
                    reply.events.items.map((event) => (
                      <Cmdk.Item
                        key={event.id}
                        value={`search-event-${event.id}`}
                        disabled={stale}
                        onSelect={pick(go.event(event))}
                        className={ITEM_CLASS}
                      >
                        <Row title={event.title} meta={eventWhen(event)} />
                      </Cmdk.Item>
                    )),
                  )}
                </>
              )}
            </Cmdk.List>
            {nothingFound && <CatSearching className="mx-auto mt-6 [--row-fill:var(--color-card)]" />}
            {/* Always mounted, so a screen reader hears each change */}
            <p
              role="status"
              className={
                !note
                  ? "sr-only"
                  : note === SEARCHING
                    ? NOTE_CLASS
                    : `${NOTE_CLASS} pb-6 ${nothingFound ? "pt-2" : "pt-4"} text-center text-ui`
              }
            >
              {note}
            </p>
          </Cmdk>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
