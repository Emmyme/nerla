import { saidByAi, stripMarks } from "@/components/ai/via"
import type { ChatKind, ChatMessage, ChatPerson, ChatSummary, MessageReaction } from "@/lib/api/chat"
import { parseServerDate } from "@/lib/dates"
import { namesOf, renderMentionText, type MentionNames } from "@/lib/mentions"
import type { ChatEvent } from "@/lib/socket"
import { type StoreMessage, type ConversationState, type ChatState, type ChatUser, store } from "@/lib/chatStore"

export const PAGE = 50

const PREVIEW_LENGTH = 120

/** What the server stores as the text of a message that only carries files */
export const FILE_PLACEHOLDER = "(file attachment)"

export function chatKey(kind: ChatKind, id: string): string {
  return `${kind}:${id.toLowerCase()}`
}

export function parseKey(key: string): [ChatKind, string] {
  const at = key.indexOf(":")
  return [key.slice(0, at) as ChatKind, key.slice(at + 1)]
}

export const keyOf = (chat: ChatSummary) => chatKey(chat.kind, chat.id)
export const isLocal = (message: ChatMessage) => message.id.startsWith("temp-")
const ms = (value: string | null | undefined) => parseServerDate(value)?.getTime() ?? 0
const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Microseconds are lost in parsing, so equal instants fall back to the server's own string, then the id, as the server orders them
function compareTimes(a: string, b: string): number {
  return ms(a) - ms(b) || text(a, b)
}

export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  return Number(isLocal(a)) - Number(isLocal(b)) || compareTimes(a.created_at, b.created_at) || text(a.id, b.id)
}

export const byActivity = (a: ChatSummary, b: ChatSummary) => ms(b.last_activity_at) - ms(a.last_activity_at)

// A page that answers late must not undo an edit already shown
export const editedLater = (shown: ChatMessage, incoming: ChatMessage) => ms(shown.edited_at) > ms(incoming.edited_at)

/** Dedupes by id, swaps a message sent from here for the server's copy, and keeps the oldest first */
export function mergePages(
  existing: StoreMessage[],
  incoming: ChatMessage[],
  keepShown: (shown: StoreMessage, incoming: ChatMessage) => boolean = editedLater,
): StoreMessage[] {
  const byId = new Map(existing.map((message) => [message.id, message]))
  const localByClient = new Map(existing.filter((m) => isLocal(m) && m.client_id).map((m) => [m.client_id, m.id]))
  for (const message of incoming) {
    const local = message.client_id && !isLocal(message) ? localByClient.get(message.client_id) : undefined
    if (local) byId.delete(local)
    const shown = byId.get(message.id)
    byId.set(message.id, shown && keepShown(shown, message) ? shown : message)
  }
  return [...byId.values()].sort(compareMessages)
}

type PinChange = { messageId: string; is_pinned: boolean; pinned_at: string | null }

/** Most recently pinned first, as the server lists them */
function sortPins(list: ChatMessage[]): ChatMessage[] {
  return list.sort((a, b) => compareTimes(b.pinned_at ?? "", a.pinned_at ?? "") || text(b.id, a.id))
}

/** The pin list after a pin or unpin. Null when a new pin is not on this device, so the list has to load again. */
export function applyPin(list: ChatMessage[], change: PinChange, message?: ChatMessage): ChatMessage[] | null {
  const rest = list.filter((m) => m.id !== change.messageId)
  if (!change.is_pinned) return rest.length === list.length ? list : rest
  const base = list.find((m) => m.id === change.messageId) ?? message
  if (!base) return null
  return sortPins([...rest, { ...base, is_pinned: true, pinned_at: change.pinned_at }])
}

const withPinCount = (chat: ChatSummary, delta: number): ChatSummary => ({ ...chat, pin_count: Math.max(0, (chat.pin_count ?? 0) + delta) })

/** Mentions read as names first, so a token is never cut short */
export function previewOf(message: ChatMessage, names: MentionNames): string {
  if (message.kind === "call") return "Call started"
  if (message.content === FILE_PLACEHOLDER) return "Sent an attachment"
  const text = renderMentionText(message.content, names)
  // What the AI said is markdown, read here without its marks
  return Array.from(saidByAi(message.done_via) ? stripMarks(text) : text.replace(/\s+/g, " ").trim())
    .slice(0, PREVIEW_LENGTH)
    .join("")
}

function summaryOf(message: ChatMessage, chat: ChatSummary | undefined): NonNullable<ChatSummary["last_message"]> {
  const preview = previewOf(message, chatNames(chat, message))
  return {
    id: message.id,
    sender_id: message.sender_id,
    preview,
    kind: message.kind,
    created_at: message.created_at,
    live: message.live,
    done_via: message.done_via ?? null,
  }
}

function later(a: string, b: string): string {
  return ms(b) > ms(a) ? b : a
}

export function withChat(state: ChatState, key: string, update: (chat: ChatSummary) => ChatSummary): ChatState {
  const index = state.chats.findIndex((chat) => keyOf(chat) === key)
  if (index < 0) return state
  const chat = update(state.chats[index])
  if (chat === state.chats[index]) return state
  const chats = state.chats.slice()
  chats[index] = chat
  return { ...state, chats: chats.sort(byActivity) }
}

function withConversation(state: ChatState, key: string, update: (conversation: ConversationState) => ConversationState): ChatState {
  const conversation = state.conversations[key]
  if (!conversation) return state
  const next = update(conversation)
  return next === conversation ? state : { ...state, conversations: { ...state.conversations, [key]: next } }
}

export function withMessages(state: ChatState, key: string, update: (messages: StoreMessage[]) => StoreMessage[]): ChatState {
  return withConversation(state, key, (conversation) => {
    const messages = update(conversation.messages)
    return messages === conversation.messages ? conversation : { ...conversation, messages }
  })
}

export function mapMessage(state: ChatState, key: string, id: string, update: (message: StoreMessage) => StoreMessage): ChatState {
  return withMessages(state, key, (messages) => {
    const index = messages.findIndex((message) => message.id === id)
    if (index < 0) return messages
    const next = messages.slice()
    next[index] = update(messages[index])
    return next
  })
}

export function withReaction(list: MessageReaction[], reaction: MessageReaction): MessageReaction[] {
  if (list.some((r) => r.id === reaction.id)) return list
  return [...list.filter((r) => !(r.user_id === reaction.user_id && r.emoji === reaction.emoji)), reaction]
}

export function withoutReaction(list: MessageReaction[], userId: string, emoji: string): MessageReaction[] {
  const next = list.filter((r) => !(r.user_id === userId && r.emoji === emoji))
  return next.length === list.length ? list : next
}

export function addMessage(state: ChatState, kind: ChatKind, chatId: string, message: ChatMessage): ChatState {
  const key = chatKey(kind, chatId)
  const conversation = state.conversations[key]
  const known = !!conversation?.messages.some((m) => m.id === message.id)
  // Past the end of a page shown around an older message, it comes with the newer pages instead
  const newestShown = conversation?.messages.filter((m) => !isLocal(m)).at(-1)
  const beyond = !!conversation?.hasNewer && !!newestShown && compareMessages(message, newestShown) > 0
  let next = beyond
    ? state
    : withMessages(state, key, (messages) => {
        // Only the latest call can be live
        const settled = message.kind === "call" ? messages.map((m) => (m.kind === "call" && m.live ? { ...m, live: false } : m)) : messages
        return mergePages(settled, [message])
      })
  next = withChat(next, key, (chat) => {
    const seen = known || chat.last_message?.id === message.id
    const newest = !chat.last_message || compareTimes(message.created_at, chat.last_message.created_at) >= 0
    return {
      ...chat,
      ...(newest ? { last_message: summaryOf(message, chat), last_activity_at: later(chat.last_activity_at, message.created_at) } : {}),
      unread: chat.unread || (!seen && message.sender_id !== state.me),
    }
  })
  return next
}

export function replaceMessage(state: ChatState, key: string, message: ChatMessage): ChatState {
  const next = mapMessage(state, key, message.id, () => message)
  return withChat(next, key, (chat) => (chat.last_message?.id === message.id ? { ...chat, last_message: summaryOf(message, chat) } : chat))
}

export function removeMessage(state: ChatState, key: string, messageId: string): ChatState {
  const next = withMessages(state, key, (messages) => {
    const rest = messages.filter((m) => m.id !== messageId)
    return rest.length === messages.length ? messages : rest
  })
  const conversation = next.conversations[key]
  return withChat(next, key, (chat) => {
    if (chat.last_message?.id !== messageId || !conversation?.loaded || conversation.hasNewer) return chat
    const last = conversation.messages.filter((m) => !isLocal(m)).at(-1)
    return { ...chat, last_message: last ? summaryOf(last, chat) : null }
  })
}

export type FileChange = { fileId: string; removed: boolean }

export const holds = (message: ChatMessage, fileId: string) => message.attachments.some((file) => file.id === fileId)

type OlderRefetch = { range: true } | { range: false; targets: { message: ChatMessage; next: ChatMessage }[] }

/**
 * The loaded messages older than the latest page that hold any of the restored files, each once however many
 * of its files came back. Each is fetched as the one-message page that ends at the message after it. Once that
 * costs more requests than loading every page again, the loaded range loads again instead
 */
export function planOlderRefetch(messages: StoreMessage[], fileIds: Set<string>): OlderRefetch {
  const server = messages.filter((m) => !isLocal(m))
  const latest = new Set(server.slice(-PAGE).map((m) => m.id))
  const targets: { message: ChatMessage; next: ChatMessage }[] = []
  server.forEach((message, index) => {
    const next = server[index + 1]
    if (!next || latest.has(message.id) || !message.attachments.some((file) => fileIds.has(file.id))) return
    targets.push({ message, next })
  })
  return targets.length > Math.ceil(server.length / PAGE) ? { range: true } : { range: false, targets }
}

/**
 * A posted file went to Trash or came back. Trash shows at once wherever the file is loaded. A restored file
 * needs its details again, so the conversations holding it are named for a refetch.
 */
export function applyFileChange(state: ChatState, change: FileChange): { state: ChatState; refetch: string[] } {
  const keys = Object.keys(state.conversations).filter((key) => state.conversations[key].messages.some((m) => holds(m, change.fileId)))
  if (!change.removed) return { state, refetch: keys }
  let next = state
  for (const key of keys) next = withMessages(next, key, (messages) => messages.map((m) => markRemoved(m, change.fileId)))
  return { state: next, refetch: [] }
}

export function markRemoved<T extends ChatMessage>(message: T, fileId: string): T {
  if (!holds(message, fileId)) return message
  return {
    ...message,
    attachments: message.attachments.map((file) => (file.id === fileId ? { id: file.id, removed: true as const } : file)),
  }
}

/** One live event applied to the list and to any loaded conversation. Typing is kept apart. */
export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "new-message":
    case "new-group-message":
      return addMessage(state, event.kind, event.chatId, event.message)
    case "message-updated":
      return replaceMessage(state, chatKey(event.kind, event.chatId), event.message)
    case "message-deleted": {
      const key = chatKey(event.kind, event.chatId)
      const next = removeMessage(state, key, event.messageId)
      return event.pinned ? withChat(next, key, (chat) => withPinCount(chat, -1)) : next
    }
    case "message-pinned": {
      // The server sends one only when the state changed
      const key = chatKey(event.kind, event.chatId)
      const { is_pinned, pinned_at } = event
      const next = mapMessage(state, key, event.messageId, (m) => ({ ...m, is_pinned, pinned_at }))
      return withChat(next, key, (chat) => withPinCount(chat, is_pinned ? 1 : -1))
    }
    case "reaction-added":
      return mapMessage(state, chatKey(event.kind, event.chatId), event.messageId, (m) => {
        const reactions = withReaction(m.reactions, event.reaction)
        return reactions === m.reactions ? m : { ...m, reactions }
      })
    case "reaction-removed":
      return mapMessage(state, chatKey(event.kind, event.chatId), event.messageId, (m) => {
        const reactions = withoutReaction(m.reactions, event.userId, event.emoji)
        return reactions === m.reactions ? m : { ...m, reactions }
      })
    case "chat-read":
      return withChat(state, chatKey(event.kind, event.id), (chat) => (chat.unread ? { ...chat, unread: false } : chat))
    case "file:changed":
      return applyFileChange(state, event).state
    default:
      return state
  }
}

export const findChat = (key: string) => store.state.chats.find((chat) => keyOf(chat) === key)

export const personOf = (user: ChatUser): ChatPerson => ({
  id: user.id,
  first_name: user.firstName,
  last_name: user.lastName,
  avatar_url: user.avatarUrl ?? null,
})

/** Names for the mentions in a chat: its members as far as known, the signed-in user, and the sender */
export function chatNames(chat: ChatSummary | undefined, message?: ChatMessage): MentionNames {
  const key = chat ? keyOf(chat) : ""
  return namesOf([...(store.people[key]?.list ?? []), ...(chat?.members ?? []), store.me && personOf(store.me), message?.sender])
}

export const findMessage = (key: string, id: string) => store.state.conversations[key]?.messages.find((m) => m.id === id)
