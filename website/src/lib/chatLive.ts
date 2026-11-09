import { isRemoved } from "@/lib/api/files"
import type { ChatKind, ChatMessage } from "@/lib/api/chat"
import { claimForWindow } from "@/lib/meetingWindow"
import { parseMentions } from "@/lib/mentions"
import { mentionPopup, mentionPopupsOn } from "@/lib/notificationStore"
import { notify } from "@/lib/notify"
import { doNotDisturb } from "@/lib/presenceStore"
import { onChatEvent, onChatsChanged, onSocketReconnect, sendTyping, type ChatEvent } from "@/lib/socket"
import {
  type ChatUser,
  type Typer,
  store,
  listeners,
  touched,
  watchers,
  loadingLatest,
  reloadAgain,
  restoring,
  readTimers,
  typingSent,
  typers,
  deleted,
  usedAt,
  failedAt,
  olderLoads,
  pinsLoading,
  pinChanges,
  peopleLoads,
  newerLoads,
  publish,
  commit,
  setConversation,
} from "@/lib/chatStore"
import {
  chatKey,
  applyPin,
  previewOf,
  withMessages,
  type FileChange,
  holds,
  applyFileChange,
  markRemoved,
  applyChatEvent,
  findChat,
  chatNames,
  findMessage,
} from "@/lib/chatModel"
import { loadList, scheduleListRefresh, readingKeys, isReading, readNow, sendRead } from "@/lib/chatList"
import { queueRestore, rememberDeleted, loadLatest } from "@/lib/chatLoad"
import { setPins, updatePins } from "@/lib/chatPins"

const TYPING_SEND_MS = 2000
const TYPING_SHOW_MS = 4000
const AWAY_MS = 60_000

const MAX_TYPING_SENT = 50

// --- Typing ---

function publishTyping(key: string) {
  const names = [...(typers.get(key)?.values() ?? [])].map(({ name, ai }) => ({ name, ai }))
  store.typing = { ...store.typing }
  if (names.length) store.typing[key] = names
  else delete store.typing[key]
  publish()
}

function stopTyping(key: string, userId: string) {
  const people = typers.get(key)
  const typer = people?.get(userId)
  if (!people || !typer) return
  clearTimeout(typer.timer)
  people.delete(userId)
  if (people.size === 0) typers.delete(key)
  publishTyping(key)
}

function onTyping(event: Extract<ChatEvent, { type: "typing" }>) {
  if (event.userId === store.me?.id) return
  const key = chatKey(event.kind, event.chatId)
  if (event.stopped) return stopTyping(key, event.userId)
  const people = typers.get(key) ?? new Map<string, Typer>()
  clearTimeout(people.get(event.userId)?.timer)
  people.set(event.userId, { name: event.name, ai: !!event.ai, timer: setTimeout(() => stopTyping(key, event.userId), TYPING_SHOW_MS) })
  typers.set(key, people)
  publishTyping(key)
}

/** At most one signal every 2 seconds per chat, the rate the server relays */
export function startTyping(kind: ChatKind, id: string) {
  const key = chatKey(kind, id)
  const now = Date.now()
  if (now - (typingSent.get(key) ?? -Infinity) < TYPING_SEND_MS) return
  if (typingSent.size >= MAX_TYPING_SENT) for (const [other, at] of typingSent) if (now - at >= TYPING_SEND_MS) typingSent.delete(other)
  typingSent.set(key, now)
  sendTyping(kind, id)
}

// --- Notifications ---

function senderName(message: ChatMessage): string {
  const sender = message.sender
  return [sender?.first_name, sender?.last_name].filter(Boolean).join(" ") || sender?.email || "New message"
}

// The unread dot covers a window in front, so only a window in the background notifies, and only one of them.
// A window in front or reading the chat still claims the message, so no other window shows it.
// The incoming call card already announces a call.
function notifyIfAway(kind: ChatKind, chatId: string, message: ChatMessage) {
  if (typeof document === "undefined" || message.sender_id === (store.me?.id ?? store.state.me) || message.kind === "call") return
  // A mention of the user pops up once, as the mention, when mention pop-ups are on
  const mine = (store.me?.id ?? store.state.me).toLowerCase()
  if (parseMentions(message.content).includes(mine) && mentionPopup({ mentionDesktop: mentionPopupsOn(), dnd: doNotDisturb() }) !== "chat")
    return
  const away = document.visibilityState !== "visible" || !document.hasFocus()
  const seen = !away || isReading(chatKey(kind, chatId))
  void claimForWindow(`message:${message.id}`, { preferred: seen }).then((mine) => {
    if (!mine || seen) return
    void notify(senderName(message), {
      body: previewOf(message, chatNames(findChat(chatKey(kind, chatId)), message)),
      tag: `message-${message.id}`,
      onClick: () => void import("@/router").then(({ router }) => router.navigate(`/messages?${kind}=${chatId}`)),
    })
  })
}

// --- Live events ---

function onFileChanged(change: FileChange) {
  const { state: next, refetch } = applyFileChange(store.state, change)
  commit(next)
  for (const key of Object.keys(store.pins)) {
    if (change.removed)
      updatePins(key, (list) => (list.some((m) => holds(m, change.fileId)) ? list.map((m) => markRemoved(m, change.fileId)) : list))
    else if (store.pins[key].messages.some((m) => holds(m, change.fileId))) setPins(key, (p) => ({ ...p, stale: true }))
  }
  for (const key of refetch) {
    // A closed conversation keeps only its latest page, which loads again when it opens
    if (!watchers.has(key)) {
      setConversation(key, (conversation) => ({ ...conversation, stale: true }))
      continue
    }
    if (loadingLatest.has(key)) reloadAgain.add(key)
    else void loadLatest(key)
    queueRestore(key, change.fileId)
  }
}

/** A file answered 404, so it shows as removed wherever it is loaded, as its Trash event would */
export function markFileMissing(fileId: string) {
  onFileChanged({ fileId, removed: true })
}

/** A description saved from a tile shows in every loaded message holding the file */
export function describeFile(fileId: string, altText: string | null) {
  const described = <T extends ChatMessage>(message: T): T =>
    holds(message, fileId)
      ? {
          ...message,
          attachments: message.attachments.map((file) => (file.id === fileId && !isRemoved(file) ? { ...file, alt_text: altText } : file)),
        }
      : message
  let next = store.state
  for (const key of Object.keys(store.state.conversations)) {
    if (store.state.conversations[key].messages.some((m) => holds(m, fileId)))
      next = withMessages(next, key, (messages) => messages.map(described))
  }
  commit(next)
  for (const key of Object.keys(store.pins)) updatePins(key, (list) => (list.some((m) => holds(m, fileId)) ? list.map(described) : list))
}

function onEvent(event: ChatEvent) {
  if (event.type === "typing") return onTyping(event)
  if (event.type === "file:changed") return onFileChanged(event)
  const key = event.type === "chat-read" ? chatKey(event.kind, event.id) : chatKey(event.kind, event.chatId)
  if (event.type === "message-deleted") rememberDeleted(event.messageId)
  const shown = event.type === "message-pinned" ? findMessage(key, event.messageId) : undefined
  commit(applyChatEvent(store.state, event), key)
  if (event.type === "message-pinned") updatePins(key, (list) => applyPin(list, event, shown))
  if (event.type === "message-deleted")
    updatePins(key, (list) => applyPin(list, { messageId: event.messageId, is_pinned: false, pinned_at: null }))
  if (event.type === "message-updated") {
    const edited = event.message
    updatePins(key, (list) => (list.some((m) => m.id === edited.id) ? list.map((m) => (m.id === edited.id ? edited : m)) : list))
  }
  if (event.type === "new-message" || event.type === "new-group-message") {
    stopTyping(key, event.message.sender_id)
    notifyIfAway(event.kind, event.chatId, event.message)
    if (!findChat(key)) scheduleListRefresh()
    else readNow(key)
  }
  if (event.type === "message-deleted" && findChat(key)?.last_message?.id === event.messageId) scheduleListRefresh()
}

function onReconnect() {
  store.reconnects += 1
  loadList()
  for (const key of Object.keys(store.pins)) if (store.pins[key].loaded) setPins(key, (p) => ({ ...p, stale: true }))
  for (const key of Object.keys(store.state.conversations)) {
    setConversation(key, (conversation) => ({ ...conversation, stale: true }))
    if (watchers.has(key)) void loadLatest(key)
  }
}

function onAway() {
  store.awaySince ??= Date.now()
}

function onBack() {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return
  const away = store.awaySince
  store.awaySince = null
  if (away !== null && Date.now() - away > AWAY_MS) loadList()
  readingKeys().forEach(readNow)
}

function onVisibility() {
  if (document.visibilityState === "visible") return onBack()
  onAway()
  ;[...readTimers.keys()].forEach(sendRead)
}

function ensureStarted() {
  if (store.started) return
  store.started = true
  window.addEventListener("focus", onBack)
  window.addEventListener("blur", onAway)
  document.addEventListener("visibilitychange", onVisibility)
  store.stops = [
    onChatEvent(onEvent),
    onChatsChanged(scheduleListRefresh),
    onSocketReconnect(onReconnect),
    () => {
      window.removeEventListener("focus", onBack)
      window.removeEventListener("blur", onAway)
      document.removeEventListener("visibilitychange", onVisibility)
    },
  ]
  if (!store.listLoaded) loadList()
}

// The store lives for the session, so live events keep every cached conversation current between pages
export function subscribe(listener: () => void) {
  listeners.add(listener)
  ensureStarted()
  return () => {
    listeners.delete(listener)
  }
}

// --- Session ---

export function resetChatStore() {
  store.generation += 1
  store.stops.forEach((stop) => stop())
  store.stops = []
  store.started = false
  store.state = { me: store.me?.id ?? "", chats: [], conversations: {} }
  store.listStatus = "loading"
  store.listLoaded = false
  store.typing = {}
  store.pins = {}
  store.awaySince = null
  clearTimeout(store.refreshTimer)
  store.refreshTimer = undefined
  touched.clear()
  loadingLatest.clear()
  reloadAgain.clear()
  restoring.clear()
  clearTimeout(store.restoreTimer)
  store.restoreTimer = undefined
  usedAt.clear()
  failedAt.clear()
  olderLoads.clear()
  newerLoads.clear()
  pinsLoading.clear()
  store.people = {}
  peopleLoads.clear()
  pinChanges.clear()
  readTimers.forEach(clearTimeout)
  readTimers.clear()
  typingSent.clear()
  typers.forEach((people) => people.forEach((typer) => clearTimeout(typer.timer)))
  typers.clear()
  deleted.clear()
}

/** Set by the auth provider. Another user signing in starts from an empty store. */
export function setChatUser(user: ChatUser | null) {
  const switched = !!store.me && store.me.id !== user?.id
  if (switched) resetChatStore()
  store.me = user
  store.state = { ...store.state, me: user?.id ?? "" }
  if (!switched) return
  publish()
  // Screens still open carry on for the new user
  if (user && listeners.size > 0) {
    ensureStarted()
    for (const key of watchers.keys()) void loadLatest(key)
  }
}
