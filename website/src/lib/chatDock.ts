import type { ChatSummary } from "@/lib/api/chat"

type Opener = (chat: ChatSummary) => void

let opener: Opener | null = null

/** The docked chat takes chats while it is in view on a desktop, and lets go when it hides */
export function setDockOpener(next: Opener | null): void {
  opener = next
}

export function chatPath(chat: Pick<ChatSummary, "kind" | "id">): string {
  return `/messages?${chat.kind}=${chat.id}`
}

/** The Chat page with the chat open at one message, which loads older pages until it is there */
export function messagePath(chat: Pick<ChatSummary, "kind" | "id">, messageId: string): string {
  return `${chatPath(chat)}&message=${encodeURIComponent(messageId)}`
}

/** Opens a chat as a docked window when the dock is in view, otherwise on the Chat page. True when docked. */
export function openChat(chat: ChatSummary, navigate: (to: string) => void): boolean {
  if (opener) {
    opener(chat)
    return true
  }
  navigate(chatPath(chat))
  return false
}

let aiOpener: (() => void) | null = null

/** The docked chat takes the AI's DM the same way while it is in view */
export function setAiDockOpener(next: (() => void) | null): void {
  aiOpener = next
}

export const AI_CHAT_PATH = "/messages?ai"

/** Opens the user's DM with the AI as a docked window when the dock is in view, otherwise in Messages. True when docked. */
export function openAiChat(navigate: (to: string) => void): boolean {
  if (aiOpener) {
    aiOpener()
    return true
  }
  navigate(AI_CHAT_PATH)
  return false
}
