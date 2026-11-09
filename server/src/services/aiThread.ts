/** The user's DM thread with the AI: its id, its pages and the history a turn reads */
import { and, desc, eq, lt, ne, sql } from "drizzle-orm"
import { aiMessages, aiRequests, aiThreads, db } from "../db"
import { actionsNote } from "../utils/aiActions"
import { escapeTag } from "../utils/aiEscape"
import { HISTORY } from "../utils/aiMemory"
import { untrusted } from "../utils/aiPrompt"
import type { ChatMessage } from "../utils/modelStream"
import type { Asker } from "./aiCards"

const THREAD_PAGE = 50

export async function threadIdOf(organizationId: string, userId: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai-thread:${organizationId}:${userId}`}, 0))`)
    const [row] = await tx
      .select({ id: aiThreads.id })
      .from(aiThreads)
      .where(and(eq(aiThreads.organizationId, organizationId), eq(aiThreads.userId, userId)))
      .limit(1)
    if (row) return row.id
    const [made] = await tx.insert(aiThreads).values({ organizationId, userId }).returning({ id: aiThreads.id })
    return made.id
  })
}

type MessageRow = typeof aiMessages.$inferSelect

export const aiMessageDto = (row: MessageRow) => ({
  id: row.id,
  role: row.role,
  content: row.content,
  status: row.status,
  requestId: row.requestId,
  createdAt: row.createdAt,
})

/** The user's DM with the AI, THREAD_PAGE messages at a time, oldest first */
export async function threadPage(asker: Asker, before?: string) {
  const threadId = await threadIdOf(asker.organizationId, asker.userId)
  const rows = await db
    .select()
    .from(aiMessages)
    .where(
      and(
        eq(aiMessages.threadId, threadId),
        eq(aiMessages.organizationId, asker.organizationId),
        sql`not (${aiMessages.content} = '' and ${aiMessages.actions} is not null)`,
        before ? lt(aiMessages.createdAt, before) : undefined,
      ),
    )
    .orderBy(desc(aiMessages.createdAt), desc(aiMessages.id))
    .limit(THREAD_PAGE)
  return rows.reverse().map(aiMessageDto)
}

const SUMMARY_HEAD = "Earlier in this chat, summarised:\n"

/**
 * The DM's earlier turns, after the running summary of the older ones. A reply or summary from a tainted request may
 * carry other users' words, so it comes back as untrusted data and taints this request too
 */
export async function dmHistory(asker: Asker, promptId: string | null): Promise<{ messages: ChatMessage[]; tainted: boolean }> {
  const threadId = await threadIdOf(asker.organizationId, asker.userId)
  const [thread] = await db
    .select({ summary: aiThreads.summary, tainted: aiThreads.summaryTainted })
    .from(aiThreads)
    .where(and(eq(aiThreads.id, threadId), eq(aiThreads.organizationId, asker.organizationId)))
    .limit(1)
  const summary: ChatMessage[] = !thread?.summary
    ? []
    : [
        {
          role: "system",
          content: thread.tainted
            ? SUMMARY_HEAD + untrusted("a summary of your earlier chat that drew on other people's words", thread.summary)
            : SUMMARY_HEAD + escapeTag(thread.summary),
        },
      ]
  const rows = await db
    .select({ role: aiMessages.role, content: aiMessages.content, actions: aiMessages.actions, tainted: aiRequests.tainted })
    .from(aiMessages)
    .leftJoin(aiRequests, and(eq(aiRequests.id, aiMessages.requestId), eq(aiRequests.organizationId, asker.organizationId)))
    .where(
      and(
        eq(aiMessages.threadId, threadId),
        eq(aiMessages.organizationId, asker.organizationId),
        promptId ? ne(aiMessages.id, promptId) : undefined,
      ),
    )
    .orderBy(desc(aiMessages.createdAt), desc(aiMessages.id))
    .limit(HISTORY)
  const kept = rows
    .reverse()
    .filter(
      (row) => (row.role === "user" && row.content.trim()) || (row.role === "assistant" && (row.content.trim() || row.actions?.length)),
    )
  const turns = kept.flatMap((row): ChatMessage[] => {
    const said: ChatMessage[] = !row.content.trim()
      ? []
      : row.role === "assistant" && row.tainted
        ? [{ role: "system", content: untrusted("an earlier answer of yours that drew on other people's words", row.content) }]
        : [{ role: row.role as "user" | "assistant", content: row.content }]
    return row.role === "assistant" && row.actions?.length ? [...said, { role: "system", content: actionsNote(row.actions) }] : said
  })
  return {
    messages: [...summary, ...turns],
    tainted: !!(thread?.summary && thread.tainted) || kept.some((row) => row.role === "assistant" && row.tainted),
  }
}
