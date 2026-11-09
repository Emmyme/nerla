import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { useLocation, useNavigate } from "react-router"
import { ChevronUp, MessageCircle } from "@/components/icons"
import { FADE_MOTION, usePresence } from "@/lib/motion"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { UnreadDot } from "@/components/ui/unread-dot"
import type { ChatKind, ChatSummary } from "@/lib/api/chat"
import { useAiTeammate } from "@/lib/aiStore"
import { AI_CHAT_PATH, setAiDockOpener, setDockOpener } from "@/lib/chatDock"
import { chatKey } from "@/lib/chatModel"
import { useChats, useTotalUnread } from "@/lib/chatHooks"
import { useDockCovered } from "@/lib/dockCover"
import { loadProfile } from "@/lib/profiles"
import { cn, remPx } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"
import { ChatList } from "./ChatList"
import { DockWindow } from "./DockWindow"
import {
  AI_DOCK,
  closeWindow,
  dockStorageKey,
  entryKey,
  MAX_WINDOWS,
  openWindow,
  parseDock,
  pruneWindows,
  setMinimized,
  type DockEntry,
} from "./dockWindows"
import { NewChatDialog } from "./NewChatDialog"

// In rem: window width plus the gap, the list panel, the closed bar and the side margins
const WINDOW_SPAN = 20.75
const PANEL_SPAN = 22.75
const BAR_SPAN = 8.75
const MARGINS = 2

function readDock(userId: string): DockEntry[] {
  if (!userId) return []
  try {
    return parseDock(localStorage.getItem(dockStorageKey(userId)))
  } catch {
    return []
  }
}

function writeDock(userId: string, windows: DockEntry[]) {
  try {
    if (windows.length) localStorage.setItem(dockStorageKey(userId), JSON.stringify(windows))
    else localStorage.removeItem(dockStorageKey(userId))
  } catch {
    return
  }
}

// Each user keeps their own windows, so another sign-in starts from what they left
function useDockWindows(userId: string) {
  const [dock, setDock] = useState(() => ({ owner: userId, windows: readDock(userId) }))
  const current = dock.owner === userId ? dock : { owner: userId, windows: readDock(userId) }
  if (current !== dock) setDock(current)

  useEffect(() => {
    if (dock.owner) writeDock(dock.owner, dock.windows)
  }, [dock])

  const update = useCallback(
    (change: (list: DockEntry[]) => DockEntry[]) =>
      setDock((d) => {
        const windows = change(d.windows)
        return windows === d.windows ? d : { ...d, windows }
      }),
    [],
  )
  return [current.windows, update] as const
}

// Windows that do not fit beside the list stay open but out of sight until there is room
function useSlots(bounds: RefObject<HTMLElement>, panelOpen: boolean): number {
  const [widthRem, setWidthRem] = useState(0)
  useEffect(() => {
    const node = bounds.current
    if (!node || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      const rem = remPx()
      setWidthRem(node.getBoundingClientRect().width / rem)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [bounds])
  if (!widthRem) return MAX_WINDOWS
  const free = widthRem - MARGINS - (panelOpen ? PANEL_SPAN : BAR_SPAN)
  return Math.min(MAX_WINDOWS, Math.max(1, Math.floor(free / WINDOW_SPAN)))
}

const AI_KEY = entryKey(AI_DOCK)

function stub(entry: DockEntry & { kind: ChatKind }): ChatSummary {
  return {
    kind: entry.kind,
    id: entry.id,
    title: entry.kind === "dm" ? "Direct message" : "Group chat",
    project_id: null,
    members: [],
    member_count: entry.kind === "dm" ? 2 : 0,
    can_pin: entry.kind === "dm",
    last_message: null,
    last_activity_at: "",
    unread: false,
  }
}

const BAR =
  "pointer-events-auto flex h-10 items-center gap-2 rounded-full border border-border bg-popover pl-1.5 pr-3.5 text-ui font-medium text-foreground shadow-[var(--shadow-popover)] transition-colors duration-150 hover:bg-app-hover focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

/**
 * The chat that follows the user from page to page. A bar opens the list and chats open as windows
 * along the bottom. Desktop only
 */
export function DockedChat({ boundsRef }: { boundsRef: RefObject<HTMLElement> }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const me = user?.id ?? ""
  const desktop = useIsDesktop()
  const covered = useDockCovered()
  const { chats, status, refresh } = useChats()
  const teammate = useAiTeammate()
  const aiThere = teammate === null || teammate.available
  const unread = useTotalUnread()
  const [windows, update] = useDockWindows(me)
  const [panelOpen, setPanelOpen] = useState(false)
  const [newChat, setNewChat] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, ChatSummary>>({})
  const [focus, setFocus] = useState<{ key: string; n: number } | null>(null)
  const slots = useSlots(boundsRef, panelOpen)
  const panel = usePresence<HTMLElement>(panelOpen)
  const bar = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const restoreTo = useRef<string | null>(null)
  const stubs = useRef(new Map<string, ChatSummary>())
  const panelId = useId()

  const onChatPage = pathname === "/messages"
  const visible = desktop && !onChatPage && !covered
  const byKey = useMemo(() => new Map(chats.map((chat) => [chatKey(chat.kind, chat.id), chat])), [chats])
  const label = unread ? "Chat, unread messages" : "Chat"
  // Every window stays mounted with its draft and uploads, and only the newest that fit are in view
  const shownKeys = useMemo(() => windows.slice(-slots).map(entryKey), [windows, slots])
  const shownRef = useRef(shownKeys)
  shownRef.current = shownKeys

  useEffect(() => {
    if (panelOpen) search.current?.focus()
  }, [panelOpen])

  // A chat opened from a draft, such as a group just made, leaves the drafts once the list knows it
  useEffect(() => {
    setDrafts((shown) => {
      const rest = Object.entries(shown).filter(([key]) => !byKey.has(key))
      return rest.length === Object.keys(shown).length ? shown : Object.fromEntries(rest)
    })
  }, [byKey])

  // A group the user has left closes its window
  useEffect(() => {
    if (status === "ready") update((list) => pruneWindows(list, new Set(byKey.keys()), new Set(Object.keys(drafts)), aiThere))
  }, [status, byKey, drafts, update, aiThere])

  // Storage keeps no names, so a DM with no messages yet is named from the other user's profile
  const unnamed =
    status === "ready"
      ? windows
          .filter((w) => w.kind === "dm" && !byKey.has(entryKey(w)) && !drafts[entryKey(w)])
          .map((w) => w.id)
          .join(",")
      : ""
  useEffect(() => {
    if (!unnamed || !me) return
    let live = true
    for (const id of unnamed.split(",")) {
      void loadProfile(me, id).then((entry) => {
        if (!live || entry.status !== "ready") return
        const { profile } = entry
        const person = { id, first_name: profile.first_name, last_name: profile.last_name, avatar_url: profile.avatar_url }
        const title = [person.first_name, person.last_name].filter(Boolean).join(" ") || profile.email
        setDrafts((shown) => ({
          ...shown,
          [entryKey({ kind: "dm", id })]: { ...stub({ kind: "dm", id, minimized: false }), title, members: [person] },
        }))
      })
    }
    return () => {
      live = false
    }
  }, [unnamed, me])

  useEffect(() => {
    if (focus && !shownKeys.includes(focus.key)) setFocus(null)
  }, [focus, shownKeys])

  // Closing a window hands focus to the window beside it, or to the bar
  useEffect(() => {
    const target = restoreTo.current
    if (!target) return
    restoreTo.current = null
    if (target === "bar") bar.current?.focus()
    else document.querySelector<HTMLElement>(`[data-dock-window="${CSS.escape(target)}"] [data-dock-title]`)?.focus()
  }, [windows])

  const open = (chat: ChatSummary) => {
    const key = chatKey(chat.kind, chat.id)
    update((list) => openWindow(list, chat))
    if (!byKey.has(key)) setDrafts((shown) => ({ ...shown, [key]: chat }))
    setFocus({ key, n: Date.now() })
  }

  const openAi = () => {
    update((list) => openWindow(list, AI_DOCK))
    setPanelOpen(false)
    setFocus({ key: AI_KEY, n: Date.now() })
  }

  // Chats opened elsewhere, such as Message on a profile card or the AI's cat, dock here while the dock is in view
  const openRef = useRef(open)
  openRef.current = open
  const openAiRef = useRef(openAi)
  openAiRef.current = openAi
  useEffect(() => {
    if (!visible) return
    setDockOpener((chat) => openRef.current(chat))
    setAiDockOpener(() => openAiRef.current())
    return () => {
      setDockOpener(null)
      setAiDockOpener(null)
    }
  }, [visible])

  const clearFocus = useCallback(() => setFocus(null), [])
  const minimize = useCallback((key: string, minimized: boolean) => update((list) => setMinimized(list, key, minimized)), [update])
  const close = useCallback(
    (key: string) => {
      const shown = shownRef.current
      const at = shown.indexOf(key)
      restoreTo.current = shown[at + 1] ?? shown[at - 1] ?? "bar"
      update((list) => closeWindow(list, key))
    },
    [update],
  )
  const expand = useCallback(
    (chat: ChatSummary | null) => {
      update((list) => closeWindow(list, chat ? chatKey(chat.kind, chat.id) : AI_KEY))
      navigate(chat ? `/messages?${chat.kind}=${chat.id}` : AI_CHAT_PATH)
    },
    [update, navigate],
  )

  // The same object for the same window, so a change elsewhere leaves it alone
  const chatFor = (entry: DockEntry & { kind: ChatKind }) => {
    const key = entryKey(entry)
    const known = byKey.get(key) ?? drafts[key]
    if (known) return known
    const cached = stubs.current.get(key)
    if (cached) return cached
    const made = stub(entry)
    stubs.current.set(key, made)
    return made
  }

  const closePanel = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || (e.target as HTMLElement).closest('[role="dialog"]')) return
    e.preventDefault()
    setPanelOpen(false)
    bar.current?.focus()
  }

  // A phone reaches chat from its tab bar
  if (!desktop) return null

  return (
    <div
      data-docked-chat=""
      data-region="dock"
      className={cn("pointer-events-none fixed right-4 bottom-4 z-40 flex items-end gap-3", (onChatPage || covered) && "hidden")}
    >
      {windows.map((entry) => {
        // The AI's window waits until the AI is known to be available
        if (entry.kind === "ai" && !teammate?.available) return null
        const key = entryKey(entry)
        const inView = shownKeys.includes(key)
        return (
          <DockWindow
            key={key}
            dockKey={key}
            chat={entry.kind === "ai" ? null : chatFor({ ...entry, kind: entry.kind })}
            me={me}
            minimized={entry.minimized}
            hidden={!inView}
            visible={visible && inView}
            focusRequest={focus?.key === key ? focus.n : 0}
            onFocused={clearFocus}
            onMinimize={minimize}
            onClose={close}
            onExpand={expand}
          />
        )
      })}

      <div className="flex flex-col items-end gap-2">
        {panel.mounted && (
          <section
            ref={panel.ref}
            id={panelId}
            aria-label="Conversations"
            data-state={panel.state}
            onKeyDown={closePanel}
            className={cn(
              "pointer-events-auto flex h-120 w-88 origin-bottom-right flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-[var(--shadow-popover)] [--row-fill:var(--color-popover)]",
              FADE_MOTION,
              "data-[state=closed]:pointer-events-none motion-safe:data-[state=closed]:slide-out-to-bottom-2 motion-safe:data-[state=closed]:zoom-out-[0.98] motion-safe:data-[state=open]:slide-in-from-bottom-2 motion-safe:data-[state=open]:zoom-in-[0.98]",
            )}
          >
            <ChatList
              compact
              searchRef={search}
              chats={chats}
              status={status}
              me={me}
              selectedKey={null}
              onSelect={open}
              onSelectAi={openAi}
              onNewChat={() => setNewChat(true)}
              onRetry={refresh}
            />
          </section>
        )}
        <button
          ref={bar}
          type="button"
          aria-label={label}
          aria-expanded={panelOpen}
          aria-controls={panelOpen ? panelId : undefined}
          onClick={() => setPanelOpen((was) => !was)}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || !panelOpen) return
            e.preventDefault()
            setPanelOpen(false)
          }}
          className={BAR}
        >
          <span aria-hidden="true" className="relative flex size-7 items-center justify-center rounded-full bg-accent">
            <MessageCircle weight="fill" className="size-4 text-white" />
            {unread && <UnreadDot className="absolute -top-0.5 -right-0.5 rounded-full ring-2 ring-popover" />}
          </span>
          <span>Chat</span>
          <ChevronUp
            aria-hidden="true"
            weight="bold"
            className={cn("motion-rotate size-3.5 text-muted-foreground", panelOpen && "rotate-180")}
          />
        </button>
      </div>

      <NewChatDialog open={newChat} mode="dm" me={me} onClose={() => setNewChat(false)} onOpenChat={open} />
    </div>
  )
}
