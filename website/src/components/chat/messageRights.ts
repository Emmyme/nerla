import { saidByAi } from "@/components/ai/via"
import type { ChatMessage } from "@/lib/api/chat"

/**
 * What the user may do with a message: edit their own words, take back anything sent as them, the AI's words for them
 * included, and pin or unpin where the chat allows it
 */
export function messageRights(message: Pick<ChatMessage, "sender_id" | "done_via">, me: string, chatCanPin: boolean) {
  const own = message.sender_id === me
  return { edit: own && !saidByAi(message.done_via), delete: own, pin: chatCanPin }
}
