import { and, eq, getTableColumns, sql } from "drizzle-orm"
import { aiMessages, aiRequests, aiThreads, db } from "../db"
import { dmCardsWaiting, expireHeld, failStaleAllowed, STALE_BEFORE, tell, type Asker } from "./aiCards"
import { testModel } from "./aiModel"
import { AiRefusal, workspaceAi, type AiSettingsRow } from "./aiSettings"
import { aiMessageDto, threadIdOf } from "./aiThread"
import { aiAsks, budgetRefusal, modelIn, NOT_AVAILABLE, paused, running, startRequest, TOO_MANY } from "./aiTurn"
// Registers what happens after an Allow card closes
import "./aiResume"

/** Forgets every paused turn, as a restart does */
export function forgetPausedForTests(): void {
  paused.clear()
}

/** The member's connection test, held to the same switch, hourly cap and budgets as a real turn */
export async function testConnection(asker: Asker): Promise<boolean> {
  const org = await workspaceAi(asker.organizationId)
  if (!org?.enabled) throw new AiRefusal(409, "Your admin has turned the AI teammate off")
  const found = await modelIn(asker, { kind: "dm" })
  if (!found) return false
  const refusal = aiAsks.take(`${asker.organizationId}:${asker.userId}`, Date.now()) ? await budgetRefusal(asker, found) : TOO_MANY
  if (refusal) throw new AiRefusal(409, refusal)
  return testModel(found.choice)
}

/** Whether the AI teammate shows for the user, with its name and avatar */
export async function teammateFor(asker: Asker): Promise<{ available: boolean; org: AiSettingsRow | null }> {
  const org = await workspaceAi(asker.organizationId)
  return { available: !!(await modelIn(asker, { kind: "dm" })), org }
}

/** A message to the AI in its DM. The message is stored first, so the thread shows it whatever happens next */
export async function askInDm(asker: Asker, content: string) {
  if (!(await modelIn(asker, { kind: "dm" }))) throw new AiRefusal(409, NOT_AVAILABLE)
  const threadId = await threadIdOf(asker.organizationId, asker.userId)
  const [message] = await db
    .insert(aiMessages)
    .values({ organizationId: asker.organizationId, threadId, role: "user", content, status: "done" })
    .returning()
  const { requestId } = await startRequest({ asker, place: { kind: "dm" }, prompt: content, promptId: message.id })
  const [linked] = await db
    .update(aiMessages)
    .set({ requestId })
    .where(and(eq(aiMessages.id, message.id), eq(aiMessages.organizationId, asker.organizationId)))
    .returning()
  return { requestId, message: aiMessageDto(linked ?? message) }
}

/** The AI teammate switch turned off, so every running request of the workspace stops at once */
export function stopWorkspaceAi(organizationId: string): void {
  for (const live of running.values()) if (live.organizationId === organizationId) live.controller.abort()
}

/**
 * Stop ends a running request. One that already ended answers true as well. A turn waiting on a card isn't
 * cancelled, since going on still takes the asker's own Allow
 */
export async function stopRequest(asker: Asker, requestId: string): Promise<boolean> {
  const live = running.get(requestId)
  if (live && live.organizationId === asker.organizationId && live.userId === asker.userId) {
    live.controller.abort()
    return true
  }
  const [row] = await db
    .select({ status: aiRequests.status })
    .from(aiRequests)
    .where(
      and(
        eq(aiRequests.id, requestId),
        eq(aiRequests.organizationId, asker.organizationId),
        eq(aiRequests.userId, asker.userId),
        eq(aiRequests.source, "ai"),
      ),
    )
    .limit(1)
  if (!row) return false
  if (row.status === "running") {
    await db
      .update(aiRequests)
      .set({ status: "stopped", finishedAt: new Date().toISOString() })
      .where(and(eq(aiRequests.id, requestId), eq(aiRequests.organizationId, asker.organizationId), eq(aiRequests.status, "running")))
  }
  return true
}

const STOP_WAIT_MS = 10_000

/**
 * Clears the user's DM with the AI: its messages, its summary and the cards still waiting in it. A turn still
 * answering there stops first, so no answer lands after. What the AI did stays done
 */
export async function clearThread(asker: Asker): Promise<void> {
  const { organizationId, userId } = asker
  const answering = [...running.values()].filter((live) => live.dm && live.organizationId === organizationId && live.userId === userId)
  for (const live of answering) live.controller.abort()
  await Promise.race([Promise.all(answering.map((live) => live.done)), new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref())])
  const cards = await dmCardsWaiting(asker)
  // Forgotten first, so an expired card adds nothing to the chat being cleared
  for (const id of cards) paused.delete(id)
  await expireHeld(asker, cards)
  const threadId = await threadIdOf(organizationId, userId)
  await db.transaction(async (tx) => {
    await tx.delete(aiMessages).where(and(eq(aiMessages.threadId, threadId), eq(aiMessages.organizationId, organizationId)))
    await tx
      .update(aiThreads)
      .set({ summary: null, summaryThrough: null, summaryThroughId: null, summaryAt: null, summaryTainted: false })
      .where(and(eq(aiThreads.id, threadId), eq(aiThreads.organizationId, organizationId)))
  })
  // Every other tab and device of theirs empties the chat too
  tell(organizationId, userId, { type: "ai-thread-cleared" })
}

/** Ends every request whose process stopped proving it is alive, and any answer row left streaming */
export async function endStaleAi(): Promise<void> {
  const finishedAt = new Date().toISOString()
  const stale = and(
    eq(aiRequests.status, "running"),
    sql`coalesce(${aiRequests.heartbeatAt}, ${aiRequests.createdAt} at time zone 'utc') < ${STALE_BEFORE}`,
  )
  // tenancy: every workspace on purpose, a dead process leaves no request running anywhere
  await db
    .update(aiRequests)
    .set({ status: "failed", finishedAt })
    .where(and(stale, eq(aiRequests.source, "ai")))
  // tenancy: every workspace on purpose, an MCP session doesn't outlive its process
  await db
    .update(aiRequests)
    .set({ status: "done", finishedAt })
    .where(and(stale, eq(aiRequests.source, "mcp")))
  // tenancy: every workspace on purpose, as above
  const cutOff = await db
    .update(aiMessages)
    .set({ status: "failed" })
    .from(aiThreads)
    .where(
      and(
        eq(aiThreads.id, aiMessages.threadId),
        eq(aiMessages.status, "streaming"),
        sql`not exists (select 1 from ai_requests r where r.id = ai_messages.request_id and r.status = 'running')`,
      ),
    )
    .returning({ ...getTableColumns(aiMessages), userId: aiThreads.userId })
  for (const { userId, ...message } of cutOff) tell(message.organizationId, userId, { type: "ai-message", message: aiMessageDto(message) })
  await failStaleAllowed()
}
