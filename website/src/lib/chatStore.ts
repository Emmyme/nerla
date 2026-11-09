import type { ChatMessage, ChatPerson, ChatSummary } from "@/lib/api/chat"
import type { User } from "@/lib/api/users"

export type ChatStatus = "loading" | "ready" | "error"

/** A message as the store holds it. Messages sent from this device carry their state until the server answers. */
export type StoreMessage = ChatMessage & {
  pending?: boolean
  failed?: boolean
  error?: string
  retry?: () => Promise<void>
  discard?: () => void
}

export type ConversationState = {
  messages: StoreMessage[]
  hasOlder: boolean
  /** Showing a page around an older message, with newer ones still to load */
  hasNewer?: boolean
  loadingNewer?: boolean
  loaded: boolean
  status: ChatStatus
  error: string | null
  loadingOlder: boolean
  stale: boolean
}

export type ChatState = { me: string; chats: ChatSummary[]; conversations: Record<string, ConversationState> }

export type ChatUser = Pick<User, "id" | "email" | "firstName" | "lastName" | "avatarUrl">

export type Typer = { name: string; ai: boolean; timer: ReturnType<typeof setTimeout> }
/** A user typing in a chat, or the AI answering there */
export type TypingPerson = { name: string; ai: boolean }

export type PinsState = { messages: ChatMessage[]; loaded: boolean; status: ChatStatus; error: string | null; stale: boolean }

/** The store's reassigned values. The collections below change in place */
export const store = {
  state: { me: "", chats: [], conversations: {} } as ChatState,
  me: null as ChatUser | null,
  listStatus: "loading" as ChatStatus,
  listLoaded: false,
  typing: {} as Record<string, TypingPerson[]>,
  pins: {} as Record<string, PinsState>,
  /** A group's whole member list, kept with the size it had, for groups larger than the list's preview */
  people: {} as Record<string, { count: number; list: ChatPerson[] }>,
  started: false,
  stops: [] as (() => void)[],
  generation: 0,
  changeSeq: 0,
  refreshTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  awaySince: null as number | null,
  reconnects: 0,
  restoreTimer: undefined as ReturnType<typeof setTimeout> | undefined,
}

export const listeners = new Set<() => void>()
export const touched = new Map<string, number>()
export const watchers = new Map<string, { count: number; active: number }>()
export const loadingLatest = new Map<string, number>()
// A change that landed while the latest page was out, so that page may predate it and loads once more
export const reloadAgain = new Set<string>()
// Restored files per open conversation, gathered briefly so a burst becomes one pass over the older pages
export const restoring = new Map<string, Set<string>>()
export const readTimers = new Map<string, ReturnType<typeof setTimeout>>()
export const typingSent = new Map<string, number>()
export const typers = new Map<string, Map<string, Typer>>()
export const deleted = new Set<string>()
export const usedAt = new Map<string, number>()
export const failedAt = new Map<string, number>()
export const olderLoads = new Map<string, Promise<void>>()
export const pinsLoading = new Set<string>()
export const pinChanges = new Map<string, number>()
export const peopleLoads = new Set<string>()
// One newer page at a time per chat, after a page shown around an older message
export const newerLoads = new Map<string, Promise<void>>()

export function publish() {
  listeners.forEach((listener) => listener())
}

export function commit(next: ChatState, key?: string) {
  if (next === store.state) return
  store.state = next
  if (key) touched.set(key, ++store.changeSeq)
  publish()
}

export function blankConversation(): ConversationState {
  return { messages: [], hasOlder: false, loaded: false, status: "loading", error: null, loadingOlder: false, stale: false }
}

export function setConversation(key: string, update: (conversation: ConversationState) => ConversationState) {
  const current = store.state.conversations[key] ?? blankConversation()
  commit({ ...store.state, conversations: { ...store.state.conversations, [key]: update(current) } })
}
