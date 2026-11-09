import { chatsAPI, groupChatsAPI, messagesAPI } from "@/lib/api/chat"
import { readNotificationsAt, watchNotificationPlaces } from "@/lib/notificationStore"
import { store, touched, watchers, readTimers, publish, commit } from "@/lib/chatStore"
import { parseKey, keyOf, byActivity, withChat, findChat } from "@/lib/chatModel"

const RELOAD_WINDOW_MS = 300

const READ_DELAY_MS = 500

let listRequest = 0

// --- Conversation list ---

export function loadList() {
  const id = ++listRequest
  const since = store.changeSeq
  const at = store.generation
  store.listLoaded = true
  chatsAPI
    .list()
    .then((list) => {
      if (at !== store.generation || id !== listRequest) return
      // A chat changed live while the request was out keeps the newer local copy
      const shown = new Map(store.state.chats.map((chat) => [keyOf(chat), chat]))
      const chats = list.map((chat) => {
        const local = shown.get(keyOf(chat))
        return local && (touched.get(keyOf(chat)) ?? 0) > since ? local : chat
      })
      for (const [key, seq] of touched) if (seq <= since) touched.delete(key)
      store.listStatus = "ready"
      store.state = { ...store.state, chats: chats.sort(byActivity) }
      publish()
      readingKeys().forEach(readNow)
    })
    .catch(() => {
      if (at !== store.generation || id !== listRequest) return
      if (store.listStatus !== "ready") store.listStatus = "error"
      publish()
    })
}

export function scheduleListRefresh() {
  if (store.refreshTimer !== undefined) return
  store.refreshTimer = setTimeout(() => {
    store.refreshTimer = undefined
    loadList()
  }, RELOAD_WINDOW_MS)
}

export function refreshChats() {
  loadList()
}

export function totalUnread(): boolean {
  return store.state.chats.some((chat) => chat.unread)
}

// --- Read state ---

export function readingKeys(): string[] {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return []
  return [...watchers].filter(([, watch]) => watch.active > 0).map(([key]) => key)
}

export const isReading = (key: string) => readingKeys().includes(key)

// Mentions here are read with the chat. One edited in, or one that came after the read, is read on its own
watchNotificationPlaces((place) => (place.startsWith("dm:") || place.startsWith("group:")) && isReading(place))

// The dot clears at once, and reads within the delay share one request
export function readNow(key: string) {
  if (!isReading(key)) return
  readNotificationsAt(key)
  if (!findChat(key)?.unread) return
  commit(
    withChat(store.state, key, (chat) => ({ ...chat, unread: false })),
    key,
  )
  if (!readTimers.has(key))
    readTimers.set(
      key,
      setTimeout(() => sendRead(key), READ_DELAY_MS),
    )
}

// Runs when the delay ends, or at once when the chat closes or the window hides
export function sendRead(key: string) {
  const timer = readTimers.get(key)
  if (timer === undefined) return
  clearTimeout(timer)
  readTimers.delete(key)
  // A message that came after the chat was left stays unread on the server too
  if (!isReading(key) && findChat(key)?.unread) return
  const [kind, id] = parseKey(key)
  const request = kind === "dm" ? messagesAPI.markAsRead(id) : groupChatsAPI.markRead(id)
  // The next list load shows the server's view again if this one is lost
  request.catch(() => undefined)
}
