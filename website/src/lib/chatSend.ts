import { ApiError } from "@/lib/api/request"
import { groupChatsAPI, messagesAPI, type ChatKind, type ChatMessage, type MessageReaction } from "@/lib/api/chat"
import { filesAPI } from "@/lib/api/files"
import { ensureNotificationPermission } from "@/lib/notify"
import { messageOf, SAVE_FAILED } from "@/lib/taskStore"
import { type StoreMessage, store, deleted, commit, blankConversation, setConversation } from "@/lib/chatStore"
import {
  FILE_PLACEHOLDER,
  chatKey,
  isLocal,
  mergePages,
  applyPin,
  withMessages,
  mapMessage,
  withReaction,
  withoutReaction,
  addMessage,
  replaceMessage,
  removeMessage,
  findChat,
  findMessage,
} from "@/lib/chatModel"
import { scheduleListRefresh } from "@/lib/chatList"
import { rememberDeleted, loadLatest } from "@/lib/chatLoad"
import { setPins } from "@/lib/chatPins"

type SendInput = {
  content: string
  fileIds?: string[]
  replyToId?: string
  /** Shown on the message while it is on its way */
  attachments?: ChatMessage["attachments"]
  /** Told how many of `fileIds` the server left off the saved message */
  onSkipped?: (count: number) => void
}

const SEND_FAILED = "Couldn't send the message. Check your connection and try again."

// --- Notifications ---

let askedPermission = false

// Asked on the first message the user sends, a gesture of their own, never on load
function askPermissionOnce() {
  if (askedPermission) return
  askedPermission = true
  void ensureNotificationPermission().catch(() => false)
}

function newClientId(): string {
  // randomUUID needs a secure context, which a self-hosted server on plain http is not
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

// --- Sending ---

function patchLocal(key: string, clientId: string, patch: Partial<StoreMessage>) {
  commit(mapMessage(store.state, key, `temp-${clientId}`, (m) => ({ ...m, ...patch })))
}

function discardLocal(key: string, clientId: string) {
  commit(withMessages(store.state, key, (messages) => messages.filter((m) => m.id !== `temp-${clientId}`)))
}

function replySnapshot(key: string, replyToId: string | undefined): ChatMessage["reply_to"] {
  const target = replyToId ? findMessage(key, replyToId) : undefined
  if (!target) return null
  return {
    id: target.id,
    content: target.content,
    sender: target.sender ? { id: target.sender.id, first_name: target.sender.first_name, last_name: target.sender.last_name } : null,
  }
}

async function deliver(kind: ChatKind, id: string, clientId: string, content: string, input: SendInput): Promise<void> {
  const key = chatKey(kind, id)
  const at = store.generation
  try {
    const saved =
      kind === "dm"
        ? await messagesAPI.sendMessage(id, content, input.fileIds, input.replyToId, clientId)
        : await groupChatsAPI.sendMessage(id, content, input.fileIds, input.replyToId, clientId)
    if (at !== store.generation) return
    if (Array.isArray(saved.attachments)) {
      const linked = new Set(saved.attachments.map((file) => file.id))
      const skipped = (input.fileIds ?? []).filter((fileId) => !linked.has(fileId)).length
      if (skipped > 0) input.onSkipped?.(skipped)
    }
    commit(addMessage(store.state, kind, id, { ...saved, client_id: saved.client_id ?? clientId }), key)
    if (!findChat(key)) scheduleListRefresh()
  } catch (err) {
    if (at !== store.generation) return
    patchLocal(key, clientId, { pending: false, failed: true, error: messageOf(err, SEND_FAILED) })
    // Refused, as after being removed from the group, so the list catches up
    if (err instanceof ApiError && err.status === 403) scheduleListRefresh()
  }
}

/**
 * Shows the message at once with a `temp-` id and swaps in the server's copy when the reply or the
 * socket echo arrives. A failed send stays in the conversation, marked failed, with `retry()`.
 */
export function sendMessage(kind: ChatKind, id: string, input: SendInput): Promise<void> {
  const files = input.fileIds?.length ?? 0
  if (!input.content.trim() && files === 0) return Promise.resolve()
  askPermissionOnce()
  const key = chatKey(kind, id)
  const clientId = newClientId()
  const content = input.content.trim() ? input.content : FILE_PLACEHOLDER
  const retry = (): Promise<void> => {
    if (!findMessage(key, `temp-${clientId}`)?.failed) return Promise.resolve()
    patchLocal(key, clientId, { pending: true, failed: false, error: undefined })
    return deliver(kind, id, clientId, content, input)
  }
  const temp: StoreMessage = {
    id: `temp-${clientId}`,
    client_id: clientId,
    sender_id: store.me?.id ?? store.state.me,
    recipient_id: kind === "dm" ? id : null,
    thread_type: kind === "group" ? "group" : null,
    thread_id: kind === "group" ? id : null,
    kind: "text",
    meta: null,
    live: false,
    content,
    is_read: false,
    is_edited: false,
    edited_at: null,
    created_at: new Date().toISOString(),
    reply_to_id: input.replyToId ?? null,
    is_pinned: false,
    pinned_at: null,
    reply_to: replySnapshot(key, input.replyToId),
    sender: store.me
      ? {
          id: store.me.id,
          email: store.me.email,
          first_name: store.me.firstName ?? null,
          last_name: store.me.lastName ?? null,
          avatar_url: store.me.avatarUrl ?? null,
        }
      : null,
    attachments: input.attachments ?? [],
    reactions: [],
    pending: true,
    retry,
    discard: () => discardLocal(key, clientId),
  }
  // Sent from a page around an older message, the chat goes back to its latest page
  const away = !!store.state.conversations[key]?.hasNewer
  if (away) setConversation(key, (c) => ({ ...blankConversation(), messages: c.messages.filter(isLocal) }))
  setConversation(key, (c) => ({ ...c, messages: mergePages(c.messages, [temp]) }))
  if (away) void loadLatest(key)
  return deliver(kind, id, clientId, content, input)
}

// --- Reactions, edits and deletes ---

/** Toggles the user's reaction. Resolves with the message to show, or null when it saved. */
export async function react(kind: ChatKind, id: string, messageId: string, emoji: string): Promise<string | null> {
  const key = chatKey(kind, id)
  const message = findMessage(key, messageId)
  if (!message || isLocal(message) || !store.me) return null
  const self = store.me
  const mine = message.reactions.find((r) => r.user_id === self.id && r.emoji === emoji)
  const setReactions = (update: (list: MessageReaction[]) => MessageReaction[]) =>
    commit(mapMessage(store.state, key, messageId, (m) => ({ ...m, reactions: update(m.reactions) })))
  const optimistic: MessageReaction = {
    id: `temp-${newClientId()}`,
    emoji,
    user_id: self.id,
    user: { id: self.id, first_name: self.firstName ?? null, last_name: self.lastName ?? null },
  }
  setReactions((list) => (mine ? withoutReaction(list, self.id, emoji) : withReaction(list, optimistic)))
  try {
    const result =
      kind === "dm" ? await messagesAPI.toggleReaction(messageId, emoji) : await groupChatsAPI.toggleReaction(id, messageId, emoji)
    const added = result.action === "added" ? result.reaction : undefined
    setReactions((list) => (added ? withReaction(list, added) : withoutReaction(list, self.id, emoji)))
    return null
  } catch (err) {
    setReactions((list) => (mine ? withReaction(list, mine) : withoutReaction(list, self.id, emoji)))
    return messageOf(err, SAVE_FAILED)
  }
}

/** Edits the user's own message. Resolves with the message to show, or null when it saved. */
export async function editMessage(kind: ChatKind, id: string, messageId: string, content: string): Promise<string | null> {
  const key = chatKey(kind, id)
  const previous = findMessage(key, messageId)
  if (!previous || isLocal(previous) || !content.trim()) return null
  commit(replaceMessage(store.state, key, { ...previous, content, is_edited: true, edited_at: new Date().toISOString() }), key)
  try {
    const saved = await messagesAPI.editMessage(messageId, content)
    commit(replaceMessage(store.state, key, saved), key)
    return null
  } catch (err) {
    commit(replaceMessage(store.state, key, previous), key)
    return messageOf(err, SAVE_FAILED)
  }
}

/** Deletes the user's own message. A failed send is just removed. Resolves with the message to show, or null. */
export async function deleteMessage(kind: ChatKind, id: string, messageId: string): Promise<string | null> {
  const key = chatKey(kind, id)
  const previous = findMessage(key, messageId)
  if (!previous) return null
  if (isLocal(previous)) {
    previous.discard?.()
    return null
  }
  rememberDeleted(messageId)
  commit(removeMessage(store.state, key, messageId), key)
  try {
    await messagesAPI.deleteMessage(messageId)
    return null
  } catch (err) {
    deleted.delete(messageId)
    commit(addMessage(store.state, kind, id, previous), key)
    return messageOf(err, SAVE_FAILED)
  }
}

/** Takes a file off the user's own message. The file stays with its owner. Resolves with the message to show, or null. */
export async function removeAttachment(kind: ChatKind, id: string, messageId: string, fileId: string): Promise<string | null> {
  const key = chatKey(kind, id)
  const previous = findMessage(key, messageId)
  if (!previous || isLocal(previous)) return null
  commit(replaceMessage(store.state, key, { ...previous, attachments: previous.attachments.filter((file) => file.id !== fileId) }), key)
  try {
    commit(replaceMessage(store.state, key, await filesAPI.removeFromMessage(messageId, fileId)), key)
    return null
  } catch (err) {
    commit(replaceMessage(store.state, key, previous), key)
    return messageOf(err, SAVE_FAILED)
  }
}

/** Pins or unpins a message for everyone in the chat. Resolves with the message to show, or null. */
export async function pinMessage(kind: ChatKind, id: string, messageId: string, pinned: boolean): Promise<string | null> {
  const key = chatKey(kind, id)
  const previous = findMessage(key, messageId) ?? store.pins[key]?.messages.find((m) => m.id === messageId)
  if (!previous || isLocal(previous)) return null
  const setPin = (is_pinned: boolean, pinned_at: string | null) => {
    commit(
      mapMessage(store.state, key, messageId, (m) => ({ ...m, is_pinned, pinned_at })),
      key,
    )
    const entry = store.pins[key]
    const next = entry?.loaded ? applyPin(entry.messages, { messageId, is_pinned, pinned_at }, previous) : null
    if (next && next !== entry?.messages) setPins(key, (p) => ({ ...p, messages: next }))
  }
  setPin(pinned, pinned ? new Date().toISOString() : null)
  try {
    const saved = kind === "dm" ? await messagesAPI.pinMessage(messageId, pinned) : await groupChatsAPI.pinMessage(id, messageId, pinned)
    setPin(saved.is_pinned, saved.pinned_at)
    return null
  } catch (err) {
    setPin(previous.is_pinned, previous.pinned_at)
    return messageOf(err, SAVE_FAILED)
  }
}

/** Nothing announces the end of a call, so an open conversation checks and settles it here */
export function setCallLive(kind: ChatKind, id: string, messageId: string, live: boolean) {
  const key = chatKey(kind, id)
  if (findMessage(key, messageId)?.live === live) return
  commit(mapMessage(store.state, key, messageId, (m) => ({ ...m, live })))
}
