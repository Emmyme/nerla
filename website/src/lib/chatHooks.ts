import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import type { ChatKind, ChatPerson, ChatSummary } from "@/lib/api/chat"
import { type ChatStatus, type StoreMessage, type TypingPerson, store, failedAt } from "@/lib/chatStore"
import { chatKey, keyOf, findChat, personOf } from "@/lib/chatModel"
import { refreshChats, totalUnread, readNow } from "@/lib/chatList"
import { loadPeople, loadLatest, loadOlder, loadNewer, watch } from "@/lib/chatLoad"
import { loadPins } from "@/lib/chatPins"
import { subscribe } from "@/lib/chatLive"

const LOAD_BACKOFF_MS = 30_000

const NO_MESSAGES: StoreMessage[] = []
const NO_NAMES: TypingPerson[] = []

/** Every member of the chat, the user included. A group larger than the list's preview loads its members once for each size it has */
export function useChatPeople(chat: ChatSummary): ChatPerson[] {
  const key = keyOf(chat)
  const loaded = useSyncExternalStore(subscribe, () => store.people[key])
  const user = useSyncExternalStore(subscribe, () => store.me)
  const partial = chat.kind === "group" && chat.members.length + 1 < chat.member_count
  const stale = partial && loaded?.count !== chat.member_count
  useEffect(() => {
    if (stale) loadPeople(key, chat.id, chat.member_count)
  }, [key, chat.id, chat.member_count, stale])
  return useMemo(() => {
    const seen = new Set<string>()
    return [...(loaded?.list ?? []), ...chat.members, ...(user ? [personOf(user)] : [])].filter((person) => {
      const id = person.id.toLowerCase()
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }, [loaded, chat.members, user])
}

/** Every DM and group, newest activity first, loaded once per session and kept current live */
export function useChats(): { chats: ChatSummary[]; status: ChatStatus; refresh: () => void } {
  const chats = useSyncExternalStore(subscribe, () => store.state.chats)
  const status = useSyncExternalStore(subscribe, () => store.listStatus)
  return { chats, status, refresh: refreshChats }
}

export function useTotalUnread(): boolean {
  return useSyncExternalStore(subscribe, totalUnread)
}

/**
 * One conversation, cached for the session. `active` false keeps it loaded and live without
 * counting as read, as for a minimized window.
 */
export function useConversation(kind: ChatKind | null, id: string | null, { active = true }: { active?: boolean } = {}) {
  const key = kind && id ? chatKey(kind, id) : null
  const conversation = useSyncExternalStore(subscribe, () => (key ? store.state.conversations[key] : undefined))
  const names = useSyncExternalStore(subscribe, () => (key ? (store.typing[key] ?? NO_NAMES) : NO_NAMES))

  useEffect(() => {
    if (!key) return
    const release = watch(key, active)
    const current = store.state.conversations[key]
    // A load that just failed is not asked again on every open and minimize, only by Try again or after a while
    const recentlyFailed = Date.now() - (failedAt.get(key) ?? -Infinity) < LOAD_BACKOFF_MS
    if ((!current?.loaded || current.stale) && !recentlyFailed) void loadLatest(key)
    readNow(key)
    return release
  }, [key, active])

  const older = useCallback(() => (key ? loadOlder(key) : Promise.resolve()), [key])
  const newer = useCallback(() => (key ? loadNewer(key) : Promise.resolve()), [key])
  const reload = useCallback(() => (key ? loadLatest(key) : Promise.resolve()), [key])

  return {
    messages: conversation?.messages ?? NO_MESSAGES,
    hasOlder: conversation?.loaded ? conversation.hasOlder : false,
    loadingOlder: conversation?.loadingOlder ?? false,
    loadOlder: older,
    hasNewer: conversation?.loaded ? !!conversation.hasNewer : false,
    loadingNewer: conversation?.loadingNewer ?? false,
    loadNewer: newer,
    reload,
    status: conversation ? (conversation.loaded ? "ready" : conversation.status) : ("loading" as ChatStatus),
    error: conversation?.error ?? null,
    typing: names,
  }
}

/**
 * A chat's pinned messages, loaded the first time `open` is true and kept current live after that.
 * Until then the count comes from the chat list.
 */
export function usePins(key: string, open: boolean) {
  const entry = useSyncExternalStore(subscribe, () => store.pins[key])
  const listed = useSyncExternalStore(subscribe, () => findChat(key)?.pin_count ?? 0)
  const stale = entry?.stale ?? false

  useEffect(() => {
    const current = store.pins[key]
    if (open && (!current?.loaded || current.stale)) void loadPins(key)
  }, [key, open, stale])

  const reload = useCallback(() => loadPins(key), [key])

  return {
    pins: entry?.messages ?? NO_MESSAGES,
    count: entry?.loaded ? entry.messages.length : listed,
    status: entry ? (entry.loaded ? "ready" : entry.status) : ("loading" as ChatStatus),
    error: entry?.error ?? null,
    reload,
  }
}
