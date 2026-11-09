/** Mentions of the AI in group chats, task comments and doc comments */
import { randomUUID } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { db, docComments, messages, taskComments, users } from "../db"
import type { Place } from "../utils/aiTypes"
import { logger } from "../utils/logger"
import { withoutAiMention } from "../utils/mentions"
import { presenceName } from "../utils/presence"
import { tell, type Asker } from "./aiCards"
import { AiRefusal } from "./aiSettings"
import { errorText } from "../utils/errorText"
import { type Quoted, type ReplyTo, startRequest } from "./aiTurn"

const CANT_ANSWER = "The AI teammate couldn't answer there."
const BARE_CHAT = "Respond to the recent conversation."
const BARE_THREAD = "Respond to this thread."
const BARE_REPLY = "Respond to this message."

type AskedIn = { kind: "message" | "doc_comment" | "task_comment"; id: string }

/** Marks a message or comment as having asked the AI. True only the first time, so its tag asks once */
async function firstAsk(source: AskedIn, organizationId: string): Promise<boolean> {
  const at = new Date().toISOString()
  const rows =
    source.kind === "message"
      ? await db
          .update(messages)
          .set({ aiAskedAt: at })
          .where(and(eq(messages.id, source.id), eq(messages.organizationId, organizationId), isNull(messages.aiAskedAt)))
          .returning({ id: messages.id })
      : source.kind === "doc_comment"
        ? await db
            .update(docComments)
            .set({ aiAskedAt: at })
            .where(and(eq(docComments.id, source.id), eq(docComments.organizationId, organizationId), isNull(docComments.aiAskedAt)))
            .returning({ id: docComments.id })
        : await db
            .update(taskComments)
            .set({ aiAskedAt: at })
            .where(and(eq(taskComments.id, source.id), eq(taskComments.organizationId, organizationId), isNull(taskComments.aiAskedAt)))
            .returning({ id: taskComments.id })
  return rows.length > 0
}

/** The group message the asker's message replied to, which everyone in the group can read */
async function quotedReply(place: Place, replyTo: ReplyTo | null, organizationId: string): Promise<Quoted | null> {
  if (place.kind !== "group" || !replyTo) return null
  const [own] = await db
    .select({ replyToId: messages.replyToId })
    .from(messages)
    .where(and(eq(messages.id, replyTo.messageId), eq(messages.organizationId, organizationId)))
    .limit(1)
  if (!own?.replyToId) return null
  const [target] = await db
    .select({
      content: messages.content,
      kind: messages.kind,
      doneVia: messages.doneVia,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(
      and(
        eq(messages.id, own.replyToId),
        eq(messages.organizationId, organizationId),
        eq(messages.threadType, "group"),
        eq(messages.threadId, place.id),
      ),
    )
    .limit(1)
  if (!target || target.kind !== "text" || !target.content.trim()) return null
  const byAi = target.doneVia?.kind === "ai" && target.doneVia.speaker === "ai"
  return { who: byAi ? "you, the AI" : presenceName(target.firstName, target.lastName), text: target.content }
}

/**
 * A mention of the AI in a group chat, task comment or doc comment. Never for a request made through an act
 * token, so nothing the AI or an agent writes starts it again. With `source`, the message or comment asks only once
 */
export function mentionAi(input: { asker: Asker; place: Place; text: string; replyTo?: ReplyTo | null; source?: AskedIn }): void {
  const { organizationId, userId } = input.asker
  const replyTo = input.replyTo ?? null
  const asked = withoutAiMention(input.text)
  const start = async () => {
    if (input.source && !(await firstAsk(input.source, organizationId))) return
    // A bare tag asks the AI to answer from what the place already holds, or from the message it replied to
    const quoted = asked ? null : await quotedReply(input.place, replyTo, organizationId)
    const prompt = asked || (quoted ? BARE_REPLY : input.place.kind === "group" ? BARE_CHAT : BARE_THREAD)
    await startRequest({ asker: input.asker, place: input.place, prompt, replyTo, quoted })
  }
  start().catch((error) => {
    if (!(error instanceof AiRefusal)) logger.warn("Starting the AI from a mention failed", { error: errorText(error) })
    // Only the asker hears why, never the others in the place
    const reason = error instanceof AiRefusal && error.code !== 404 ? error.message : CANT_ANSWER
    tell(organizationId, userId, { type: "ai-request", requestId: randomUUID(), status: "refused", reason })
  })
}
