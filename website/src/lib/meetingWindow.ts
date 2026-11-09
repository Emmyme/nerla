import { isTauri } from "@tauri-apps/api/core"
import { toast } from "sonner"
import type { ChatKind } from "@/lib/api/chat"
import { webOrigin } from "@/lib/serverUrl"

const NORMAL = { width: 1040, height: 700 }
const MINI = { width: 380, height: 240, margin: 16, taskbar: 48 }

let tauriLabel: string | null = null

// Only the desktop build loads the Tauri window module, early, so isMeetingWindow can answer at once
if (typeof window !== "undefined" && isTauri()) {
  import("@tauri-apps/api/window")
    .then((module) => {
      tauriLabel = module.getCurrentWindow().label
    })
    .catch(() => {})
}

/** True in a desktop meeting window or a web meeting popup, where leaving closes the window */
export function isMeetingWindow(): boolean {
  if (typeof window === "undefined") return false
  if (isTauri()) return tauriLabel?.startsWith("meeting-") ?? false
  return Boolean(window.opener) || window.name.startsWith("meeting-")
}

/** One room per event, shared by every occurrence of a series */
export function eventRoom(event: { id: string; series_id: string | null }): string {
  return `meeting-${event.series_id ?? event.id}`
}

/** The one room two users of a workspace call each other in, the same whoever calls. The server names it the same way. */
export function dmRoom(organizationId: string, a: string, b: string): string {
  const [first, second] = [a.toLowerCase(), b.toLowerCase()].sort()
  return `o${organizationId.slice(0, 8).toLowerCase()}-dm-${first}-${second}`
}

export type CallChat = { kind: ChatKind; id: string }

/** A call started from a chat carries the chat, so its end screen can lead back to it */
export function meetingPath(roomId: string, chat?: CallChat | null): string {
  const path = `/meeting-room/${encodeURIComponent(roomId)}`
  return chat ? `${path}?from=chat&chat=${chat.kind}:${encodeURIComponent(chat.id)}` : path
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
// The workspace prefix is optional
const DM_ROOM = new RegExp(`^(?:o[0-9a-f]{8}-)?dm-(${UUID})-(${UUID})$`, "i")

/** The chat a call belongs to, from the window's link, or for a 1:1 room the DM with the other user */
export function callChat(search: URLSearchParams, roomId: string, me: string | null | undefined): CallChat | null {
  const [kind, id] = search.get("from") === "chat" ? (search.get("chat") ?? "").split(":") : []
  if ((kind === "dm" || kind === "group") && id && new RegExp(`^${UUID}$`, "i").test(id)) return { kind, id: id.toLowerCase() }
  const dm = DM_ROOM.exec(roomId)
  if (!dm || !me) return null
  const self = me.toLowerCase()
  const [a, b] = [dm[1].toLowerCase(), dm[2].toLowerCase()]
  if (self !== a && self !== b) return null
  return { kind: "dm", id: self === a ? b : a }
}

/** The link guests outside the workspace join through, by way of the lobby */
export function joinLink(roomName: string): string {
  return `${webOrigin()}/join/${roomName}`
}

/** Room names compare without case, since scheduled rooms are lowercased by the server */
export function sameRoom(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** 1:1 call rooms take no guests, so they have no join link */
export function hasJoinLink(roomName: string): boolean {
  return !/^(o[0-9a-f]{8}-)?dm-/i.test(roomName)
}

const CLAIMS = "nerla-window-claims"
const CLAIM_TTL = 10_000

/**
 * Socket events reach every window of the user, so the one that acts on an event claims it first.
 * A focused window claims at once, a visible one a moment later and a hidden one last, so the window in front wins.
 * Without storage every window acts.
 */
export async function claimForWindow(key: string, { preferred = false } = {}): Promise<boolean> {
  const wait = (document.hasFocus() ? 0 : document.visibilityState === "visible" ? 300 : 600) + (preferred ? 0 : 100)
  await new Promise((resolve) => setTimeout(resolve, wait))
  let storage: Storage
  try {
    storage = localStorage
  } catch {
    return true
  }
  const now = Date.now()
  const claims = readClaims(storage)
  for (const k of Object.keys(claims)) if (!(now - claims[k] <= CLAIM_TTL)) delete claims[k]
  const taken = key in claims
  if (!taken) claims[key] = now
  try {
    storage.setItem(CLAIMS, JSON.stringify(claims))
  } catch {
    return true
  }
  return !taken
}

// A corrupt value reads as no claims and is overwritten by the next write
function readClaims(storage: Storage): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CLAIMS) ?? "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, at]) => typeof at === "number"))
  } catch {
    return {}
  }
}

export async function openMeetingWindow(roomId: string, { chat }: { chat?: CallChat | null } = {}): Promise<void> {
  const id = roomId.trim()
  if (!id) return
  const path = meetingPath(id, chat)

  if (isTauri()) {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow")
    const label = `meeting-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      await existing.setFocus()
      return
    }
    const base = window.location.href.split("#")[0]
    const win = new WebviewWindow(label, {
      url: `${base}#${path}`,
      title: "Nerla Meeting",
      width: NORMAL.width,
      height: NORMAL.height,
      minWidth: 360,
      minHeight: 220,
      decorations: false,
    })
    win.once("tauri://error", (e) => {
      console.error("Failed to open meeting window:", e)
      toast.error("Couldn't open the meeting window. Try again.")
    })
    return
  }

  const features = `width=${NORMAL.width},height=${NORMAL.height},menubar=no,toolbar=no,location=no,status=no`
  const popup = window.open(path, `meeting-${id}`, features)
  if (!popup) {
    window.location.assign(path)
  }
}

type Bounds = { x: number; y: number; width: number; height: number; maximized: boolean }

// Where the window was before it went to the corner, so expanding puts it back
let beforeMini: Bounds | null = null

export async function setMeetingMini(mini: boolean): Promise<void> {
  if (isTauri()) {
    const { getCurrentWindow, currentMonitor } = await import("@tauri-apps/api/window")
    const { LogicalSize, PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/dpi")
    const win = getCurrentWindow()
    if (mini) {
      if (await win.isMinimized()) await win.unminimize()
      if (!beforeMini) {
        const [position, size, maximized] = await Promise.all([win.outerPosition(), win.innerSize(), win.isMaximized()])
        beforeMini = { x: position.x, y: position.y, width: size.width, height: size.height, maximized }
      }
      if (beforeMini.maximized) await win.unmaximize()
      await win.setAlwaysOnTop(true)
      await win.setSize(new LogicalSize(MINI.width, MINI.height))
      const monitor = await currentMonitor()
      if (monitor) {
        const scale = monitor.scaleFactor || 1
        const x = monitor.position.x + monitor.size.width - (MINI.width + MINI.margin) * scale
        const y = monitor.position.y + monitor.size.height - (MINI.height + MINI.margin + MINI.taskbar) * scale
        await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
      }
    } else {
      const saved = beforeMini
      beforeMini = null
      await win.setAlwaysOnTop(false)
      if (saved) {
        await win.setSize(new PhysicalSize(saved.width, saved.height))
        await win.setPosition(new PhysicalPosition(saved.x, saved.y))
        if (saved.maximized) await win.maximize()
      } else {
        await win.setSize(new LogicalSize(NORMAL.width, NORMAL.height))
        await win.center()
      }
    }
    return
  }

  if (mini) {
    try {
      window.resizeTo(MINI.width, MINI.height)
      window.moveTo(screen.availWidth - MINI.width - MINI.margin, screen.availHeight - MINI.height - MINI.margin)
    } catch {
      // Browsers may block resizing or moving the popup
    }
  } else {
    try {
      window.resizeTo(NORMAL.width, NORMAL.height)
    } catch {
      // Browsers may block resizing the popup
    }
  }
}

export async function minimizeWindow(): Promise<void> {
  if (!isTauri()) return
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  await getCurrentWindow().minimize()
}

/** Calls back whenever the desktop window ends up minimized, from the taskbar or the keyboard, until the returned stop runs */
export function watchMinimize(onMinimized: () => void): () => void {
  if (!isTauri()) return () => {}
  let stopped = false
  const stops: (() => void)[] = []
  void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
    const win = getCurrentWindow()
    const check = () =>
      void win.isMinimized().then(
        (minimized) => minimized && !stopped && onMinimized(),
        () => {},
      )
    const listeners = [win.onResized(check), win.onFocusChanged(({ payload: focused }) => !focused && check())]
    for (const listener of listeners) {
      try {
        const stop = await listener
        if (stopped) stop()
        else stops.push(stop)
      } catch (error) {
        console.debug("Window minimize listener unavailable:", error)
      }
    }
  })
  return () => {
    stopped = true
    stops.forEach((stop) => stop())
  }
}

export async function leaveMeetingWindow(fallback: () => void): Promise<void> {
  if (isTauri()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    const current = getCurrentWindow()
    if (current.label.startsWith("meeting-")) {
      await current.close()
      return
    }
  } else if (window.opener || window.name.startsWith("meeting-")) {
    window.close()
    return
  }
  fallback()
}

/**
 * Leaves the meeting for a page of the app. A web popup takes its opener there when it shares the origin, then closes.
 * A tab shows the page itself. Elsewhere the window just closes.
 */
export async function leaveMeetingWindowFor(path: string, navigate: (to: string) => void): Promise<void> {
  if (!isTauri() && window.opener) {
    try {
      const opener = window.opener as Window & typeof globalThis
      if (opener.location.origin === window.location.origin) {
        const idx = ((opener.history.state as { idx?: number } | null)?.idx ?? 0) + 1
        opener.history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx }, "", path)
        opener.dispatchEvent(new opener.PopStateEvent("popstate", { state: opener.history.state }))
        opener.focus()
      }
    } catch {
      // An opener from another origin is left alone
    }
  }
  return leaveMeetingWindow(() => navigate(path))
}
