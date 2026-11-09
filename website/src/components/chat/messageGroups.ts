import type { ChatMessage } from "@/lib/api/chat"
import { dayKey, formatDayLabel, parseServerDate } from "@/lib/dates"

const GROUP_MS = 5 * 60 * 1000

// What the AI said, or what an agent did, runs apart from the user's own messages
function senderOf(message: ChatMessage): string {
  const via = message.done_via
  if (!via) return message.sender_id
  return `${message.sender_id}:${via.kind === "agent" ? `agent:${via.tokenId}` : via.speaker === "ai" ? "ai" : "via"}`
}

type MessageBlock<M extends ChatMessage = ChatMessage> = { kind: "day"; label: string } | { kind: "group"; senderId: string; items: M[] }

/** Day headings, then runs of one sender's messages that are at most 5 minutes apart. A call stands alone */
export function groupMessages<M extends ChatMessage>(messages: M[], now: Date): MessageBlock<M>[] {
  const blocks: MessageBlock<M>[] = []
  let day = ""
  let group: Extract<MessageBlock<M>, { kind: "group" }> | null = null
  let lastAt = 0
  for (const message of messages) {
    const at = parseServerDate(message.created_at) ?? now
    const key = dayKey(at)
    if (key !== day) {
      blocks.push({ kind: "day", label: formatDayLabel(at, now) })
      day = key
      group = null
    }
    const joins =
      group !== null &&
      group.senderId === senderOf(message) &&
      message.kind !== "call" &&
      group.items[0].kind !== "call" &&
      at.getTime() - lastAt <= GROUP_MS
    if (joins) group!.items.push(message)
    else {
      group = { kind: "group", senderId: senderOf(message), items: [message] }
      blocks.push(group)
    }
    lastAt = at.getTime()
  }
  return blocks
}
