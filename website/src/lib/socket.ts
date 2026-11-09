import { getWsBaseUrl } from "@/lib/serverUrl"
import type { AiHeld, AiHeldStatus, AiMessage, AiPlace } from "@/lib/api/ai"
import type { ChatKind, ChatMessage, MessageReaction } from "@/lib/api/chat"
import type { NotificationItem, NotificationPrefs } from "@/lib/api/notifications"
import type { TimeEntry, TimerDto } from "@/lib/api/time"
import type { StatusChoice } from "@/lib/presence"

type WebSocketMessage = {
  type: string
  [key: string]: unknown
}

type MessageHandler = (data: Record<string, unknown>) => void

let ws: WebSocket | null = null
let reconnectAttempts = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
// Signed in means the socket should be up, so it keeps retrying until sign-out
let wanted = false
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000

/** 1s, 2s, 4s and so on, capped at 30s */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
}

const messageHandlers = new Map<string, Set<MessageHandler>>()
const reconnectHandlers = new Set<() => void>()
// Set by any close, a failed first try included, so the next sign-in catches up on what was missed
let needsCatchUp = false
// What the server should know about this window, sent again on every new connection
const own: { idle: boolean; call: string | null } = { idle: false, call: null }
let ready = false
// The workspace this socket signed in to. Events naming another one are dropped
let socketOrg: string | null = null

function sendWhenReady(message: WebSocketMessage) {
  if (ready && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

function sendOwn() {
  if (own.idle) sendWhenReady({ type: "presence", state: "idle" })
  if (own.call) sendWhenReady({ type: "call", roomName: own.call })
}

function handleMessage(event: MessageEvent) {
  try {
    const data = JSON.parse(event.data.toString())
    if (data.type === "auth_success") {
      socketOrg = typeof data.organizationId === "string" ? data.organizationId : null
      ready = true
      sendOwn()
      if (needsCatchUp) {
        needsCatchUp = false
        reconnectHandlers.forEach((handler) => handler())
      }
    } else if (socketOrg && typeof data.organizationId === "string" && data.organizationId !== socketOrg) {
      return
    }

    const handlers = messageHandlers.get(data.type)
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data)
        } catch (error) {
          console.error("Error in message handler for %s:", data.type, error)
        }
      })
    }
  } catch (error) {
    console.error("Error parsing WebSocket message:", error)
  }
}

function setupWebSocket(token?: string) {
  const wsUrl = getWsBaseUrl()

  // Web authenticates with the cookie on the upgrade, desktop sends the JWT as
  // its first message. Neither puts the token in the URL.
  const url = `${wsUrl}/ws`

  const socket = new WebSocket(url)
  ws = socket

  socket.onopen = () => {
    reconnectAttempts = 0
    if (token) {
      socket.send(JSON.stringify({ type: "auth", token }))
    }
  }

  socket.onclose = () => {
    if (ws !== socket) return
    ws = null
    ready = false
    socketOrg = null
    needsCatchUp = true
    if (!wanted || reconnectTimer) return

    const delay = reconnectDelay(reconnectAttempts)
    reconnectAttempts++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (wanted && (!ws || ws.readyState === WebSocket.CLOSED)) {
        setupWebSocket(token)
      }
    }, delay)
  }

  socket.onerror = (error) => {
    console.error("WebSocket connection error:", error)
  }

  socket.onmessage = handleMessage
}

export function initializeSocket(token?: string) {
  wanted = true
  if (ws?.readyState === WebSocket.OPEN) {
    return ws
  }

  if (ws?.readyState === WebSocket.CONNECTING) {
    return ws
  }

  setupWebSocket(token)
  return ws
}

export function disconnectSocket() {
  wanted = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  if (ws) {
    ws.close()
    ws = null
  }
  needsCatchUp = false
  ready = false
  socketOrg = null
  own.idle = false
  own.call = null
  messageHandlers.clear()
}

/** Whether this window has gone idle. Each connection is new and active, so only a change is sent. */
export function setPresenceIdle(idle: boolean) {
  if (own.idle === idle) return
  own.idle = idle
  sendWhenReady({ type: "presence", state: idle ? "idle" : "active" })
}

/** The call this window is in, or null after it leaves */
export function setPresenceCall(roomName: string | null) {
  if (own.call === roomName) return
  own.call = roomName
  sendWhenReady({ type: "call", roomName })
}

/** Whether this window is in a call, which a page reload would end */
export function inCall(): boolean {
  return own.call !== null
}

type PresenceEvent = { userId: string; online: boolean; idle: boolean; inCall: boolean; status?: StatusChoice | null }

/** A user in the workspace came online, went idle, joined a call and so on */
export function onPresence(callback: (event: PresenceEvent) => void): () => void {
  return onMessage<PresenceEvent>("presence", callback)
}

/** These users' calendars changed, so their availability may have too */
export function onPresenceCalendar(callback: (event: { userIds: string[] }) => void): () => void {
  return onMessage<{ userIds: string[] }>("presence-calendar", callback)
}

/** How many are in a call room now, sent when the count changes */
export function onRoomPresence(callback: (event: { roomName: string; count: number }) => void): () => void {
  return onMessage<{ roomName: string; count: number }>("room-presence", callback)
}

/** A task in one of the user's projects was written, so task lists reload */
export function onTasksPushed(callback: (event: { projectId: string }) => void): () => void {
  return onMessage<{ projectId: string }>("tasks-changed", callback)
}

/** Runs each time the socket is signed in again after a drop, so screens can catch up on what they missed */
export function onSocketReconnect(callback: () => void): () => void {
  reconnectHandlers.add(callback)
  return () => {
    reconnectHandlers.delete(callback)
  }
}

function sendMessage(message: WebSocketMessage) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message))
  } else {
    console.warn("WebSocket is not connected. Message not sent:", message)
  }
}

function onMessage<T = Record<string, unknown>>(type: string, callback: (data: T) => void): () => void {
  const handler = (data: Record<string, unknown>) => {
    callback(data as T)
  }

  if (!messageHandlers.has(type)) {
    messageHandlers.set(type, new Set())
  }
  messageHandlers.get(type)!.add(handler)

  return () => {
    const handlers = messageHandlers.get(type)
    if (handlers) {
      handlers.delete(handler)
      if (handlers.size === 0) {
        messageHandlers.delete(type)
      }
    }
  }
}

/** Every chat event carries the chat as the receiving user knows it: a DM by the other user's id, a group by its id */
export type ChatEvent =
  | { type: "new-message" | "new-group-message"; kind: ChatKind; chatId: string; message: ChatMessage }
  | { type: "message-updated"; kind: ChatKind; chatId: string; message: ChatMessage }
  | { type: "message-deleted"; kind: ChatKind; chatId: string; messageId: string; pinned?: boolean }
  | { type: "message-pinned"; kind: ChatKind; chatId: string; messageId: string; is_pinned: boolean; pinned_at: string | null }
  | { type: "reaction-added"; kind: ChatKind; chatId: string; messageId: string; reaction: MessageReaction }
  | { type: "reaction-removed"; kind: ChatKind; chatId: string; messageId: string; emoji: string; userId: string }
  /** `ai` is the AI answering in the chat, and `stopped` ends its dots at once */
  | { type: "typing"; kind: ChatKind; chatId: string; userId: string; name: string; ai?: boolean; stopped?: boolean }
  | { type: "chat-read"; kind: ChatKind; id: string }
  /** A file posted in the chat went to Trash, or came back from it */
  | { type: "file:changed"; kind: ChatKind; chatId: string; fileId: string; removed: boolean }

const CHAT_EVENT_TYPES = [
  "new-message",
  "new-group-message",
  "message-updated",
  "message-deleted",
  "message-pinned",
  "reaction-added",
  "reaction-removed",
  "typing",
  "chat-read",
  "file:changed",
] as const satisfies readonly ChatEvent["type"][]

/** One handler for every chat event */
export function onChatEvent(callback: (event: ChatEvent) => void): () => void {
  const offs = CHAT_EVENT_TYPES.map((type) => onMessage<ChatEvent>(type, callback))
  return () => offs.forEach((off) => off())
}

export type NotificationEvent =
  /** `bell: false` is a pop-up only. Its item never joins the list */
  | { type: "notification:new"; item: NotificationItem; unread: number; bell: boolean; desktop: boolean }
  /** A grouped change merged into an entry, which moves to the top unread and never pops up */
  | { type: "notification:updated"; item: NotificationItem; unread: number }
  /** `removed` went with their source, so they leave the list */
  | { type: "notification:read"; unread: number; ids?: string[]; removed?: string[] }
  /** The user's settings changed in another session */
  | { type: "notification:prefs"; prefs: NotificationPrefs }

export function onNotificationEvent(callback: (event: NotificationEvent) => void): () => void {
  const offs = (["notification:new", "notification:updated", "notification:read", "notification:prefs"] as const).map((type) =>
    onMessage<NotificationEvent>(type, callback),
  )
  return () => offs.forEach((off) => off())
}

export type TimeEvent =
  /** The user's timer started or stopped, in any of their sessions. `stopped` is what the stop logged */
  | { type: "time:timer"; timer: TimerDto | null; stopped: TimeEntry | null; stoppedLocked?: boolean }
  /** The user's entries on these dates changed */
  | { type: "time:changed"; dates: string[] }
  /** The workspace switched time tracking on or off */
  | { type: "time:enabled"; enabled: boolean }

export function onTimeEvent(callback: (event: TimeEvent) => void): () => void {
  const offs = (["time:timer", "time:changed", "time:enabled"] as const).map((type) => onMessage<TimeEvent>(type, callback))
  return () => offs.forEach((off) => off())
}

type AiHeldEvent =
  /** A card now waits for the user's Allow, from the AI teammate or one of their agents */
  | { type: "ai-held"; held: AiHeld }
  /** A card was answered or ran out of time, in any of the user's sessions */
  | { type: "ai-held-closed"; id: string; status: AiHeldStatus }

export function onAiHeldEvent(callback: (event: AiHeldEvent) => void): () => void {
  const offs = (["ai-held", "ai-held-closed"] as const).map((type) => onMessage<AiHeldEvent>(type, callback))
  return () => offs.forEach((off) => off())
}

export type AiEvent =
  /** A turn finished. `message` is null when its answer went to a shared place or waits on a card */
  | { type: "ai-done"; requestId: string; message: AiMessage | null; place?: AiPlace }
  /** A running request names the place it answers in */
  | {
      type: "ai-request"
      requestId: string
      status: "running" | "done" | "stopped" | "failed" | "refused"
      reason?: string
      place?: AiPlace
    }
  /** A message added to the user's DM by the server, such as a question kept private */
  | { type: "ai-message"; message: AiMessage }
  /** The user's chat with the AI was cleared, here or on another device */
  | { type: "ai-thread-cleared" }

export function onAiEvent(callback: (event: AiEvent) => void): () => void {
  const offs = (["ai-done", "ai-request", "ai-message", "ai-thread-cleared"] as const).map((type) => onMessage<AiEvent>(type, callback))
  return () => offs.forEach((off) => off())
}

/** A user joined, left or was added to a group, so the user's chat list changed */
export function onChatsChanged(callback: () => void): () => void {
  return onMessage("chats-changed", () => callback())
}

/** Tells the others in the chat that the user is typing. The server relays at most one every 2 seconds. */
export function sendTyping(kind: ChatKind, chatId: string) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "typing", kind, chatId }))
}

export function emitMeetingInviteDeclined(targetUserId: string, roomName: string) {
  sendMessage({
    type: "meeting-invite-declined",
    targetUserId,
    roomName,
  })
}

export function onMeetingInvite(
  callback: (data: {
    roomName: string
    title: string
    callerName: string
    callerEmail: string
    callerId: string
    /** Set when the call was started from a chat */
    chat?: { kind: ChatKind; id: string }
  }) => void,
): () => void {
  return onMessage("meeting-invite", callback)
}

export function onMeetingInviteDeclined(callback: (data: { userId: string; name: string; roomName: string }) => void): () => void {
  return onMessage("meeting-invite-declined", callback)
}

export function onLobbyRequest(callback: (data: { guestName: string; sessionId: string; roomName: string }) => void): () => void {
  return onMessage("lobby-request", callback)
}

export function onLobbyResolved(
  callback: (data: { roomName: string; sessionId: string; outcome: "admitted" | "denied" | "cancelled" }) => void,
): () => void {
  return onMessage("lobby-resolved", callback)
}

/** Something on the calendar of the users involved changed. `eventId` is the series or the event. */
export function onCalendarChanged(callback: (data: { eventId: string }) => void): () => void {
  return onMessage("calendar-changed", callback)
}
