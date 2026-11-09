/** Allow cards: holding, answering, expiring and closing them */
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm"
import { aiHeld, aiRequests, aiTokens, db } from "../db"
import { HOLD_MS, takeBatch, type HeldItem, type TakeError } from "../utils/aiGate"
import type { Place, Via } from "../utils/aiTypes"
import { logger } from "../utils/logger"
import { tokenLive } from "../utils/tokenScopes"
import { logActivity, sourceOf, type ActivityEntry } from "./aiActivity"
import { AiRefusal, workspaceAi } from "./aiSettings"
import { toolByName, type ToolContext, type ToolResult } from "./aiTools"
import { dropAiPending, notify } from "./notifications"
import { isMemberOf } from "./tenancy"
import { sendToUser } from "./websocket"
import { live } from "../live/live"
import { errorText } from "../utils/errorText"
import { argTarget, FAILED, runAndRecord, RUN_FAILED } from "./aiToolRun"

export type HeldCard = { id: string; items: HeldItem[] }

export type HeldStatus = "waiting" | "allowed" | "denied" | "expired" | "done" | "failed"
export type HeldResult = { id: string; tool: string; result: ToolResult }
export type HeldKind = "changes" | "share" | "reply"
export type HeldClosed = {
  id: string
  organizationId: string
  userId: string
  requestId: string
  kind: HeldKind
  status: HeldStatus
  results: HeldResult[] | null
  /** The card's paused AI turn, given only to this process's handler and never published */
  resume?: unknown
}

let heldClosed: (closed: HeldClosed) => void = () => {}

/** The AI teammate goes on after every card that closes. An agent waiting on one card hears it on `held:<id>` */
export function onHeldClosed(handler: (closed: HeldClosed) => void): void {
  heldClosed = handler
}

export type Asker = { userId: string; organizationId: string; isAdmin: boolean }
type HeldRow = typeof aiHeld.$inferSelect

const utcNow = sql`(now() at time zone 'utc')`

/** Sends an AI event to the user's sockets. A failure is logged and never fails the caller */
export function tell(organizationId: string, userId: string, data: Record<string, unknown>) {
  try {
    sendToUser(organizationId, userId, data)
  } catch (error) {
    logger.warn("Sending an AI event failed", { type: data.type, error: errorText(error) })
  }
}

/** Why an agent can no longer act for its owner, or null while it still can */
async function agentRefusal(organizationId: string, userId: string, tokenId: string | null): Promise<string | null> {
  const [token] = tokenId
    ? await db
        .select({ expiresAt: aiTokens.expiresAt, revokedAt: aiTokens.revokedAt })
        .from(aiTokens)
        .where(and(eq(aiTokens.id, tokenId), eq(aiTokens.organizationId, organizationId), eq(aiTokens.userId, userId)))
        .limit(1)
    : []
  if (!token || !tokenLive(token, new Date())) return "This agent's token was revoked or has expired, so nothing ran"
  if (!(await workspaceAi(organizationId))?.mcpEnabled) return "MCP access is off for this workspace, so nothing ran"
  if (!(await isMemberOf(userId, organizationId))) return "Not found"
  return null
}

/** An allowed card whose agent, or the AI teammate, can no longer act. It closes as denied */
class AgentStopped extends Error {}

const AI_OFF = "The AI teammate is off for this workspace, so nothing ran"

/** The AI teammate's switch stops its cards as MCP's stops an agent's */
async function stoppedFor(asker: Asker, origin: Origin): Promise<void> {
  if (origin.source === "mcp") {
    const refusal = await agentRefusal(asker.organizationId, asker.userId, origin.tokenId)
    if (refusal) throw new AgentStopped(refusal)
  } else if (!(await workspaceAi(asker.organizationId))?.enabled) {
    throw new AgentStopped(AI_OFF)
  }
}

const heldDto = (row: HeldRow, origin: { source: string; tokenName: string | null; place: unknown }) => ({
  id: row.id,
  kind: row.kind,
  requestId: row.requestId,
  source: origin.source,
  tokenName: origin.tokenName,
  // The asker's own view of that place shows the card
  place: origin.place ?? null,
  // Only ever sent to the asker, who sees every value that will run, not just the clipped summary
  items: (row.items as HeldItem[]).map(({ id, tool, args, summary }) => ({ id, tool, args, summary })),
  status: row.status,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
})

export async function insertHeld(ctx: ToolContext, kind: HeldKind, items: HeldItem[]): Promise<HeldCard> {
  const [row] = await db
    .insert(aiHeld)
    .values({
      organizationId: ctx.organizationId,
      userId: ctx.askerId,
      requestId: ctx.requestId,
      kind,
      items,
      expiresAt: new Date(Date.now() + HOLD_MS).toISOString(),
    })
    .returning()
  const tokenName = ctx.via.kind === "agent" ? ctx.via.tokenName : null
  tell(ctx.organizationId, ctx.askerId, { type: "ai-held", held: heldDto(row, { source: sourceOf(ctx.via), tokenName, place: ctx.place }) })
  if (ctx.via.kind === "agent") await notify(ctx.organizationId, { type: "ai_pending", actorId: null, userId: ctx.askerId, heldId: row.id })
  return { id: row.id, items }
}

/** What a reply card keeps: the answer as it will be posted, and where */
export type ReplyArgs = { content: string; place: Place; replyTo: { messageId: string } | null }

type ReplyPoster = (asker: Asker, args: ReplyArgs) => Promise<void>
let replyPoster: ReplyPoster | null = null

/** The AI teammate posts an allowed reply through its own shared-reply path */
export function onReplyAllowed(poster: ReplyPoster): void {
  replyPoster = poster
}

async function closeHeld(
  row: Pick<HeldRow, "id" | "organizationId" | "userId" | "requestId" | "kind">,
  status: HeldStatus,
  results: HeldResult[] | null,
  resume?: unknown,
) {
  tell(row.organizationId, row.userId, { type: "ai-held-closed", id: row.id, status })
  const kind: HeldKind = row.kind === "share" || row.kind === "reply" ? row.kind : "changes"
  const closed: HeldClosed = {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    requestId: row.requestId,
    kind,
    status,
    results,
  }
  heldClosed({ ...closed, resume })
  live.publish(`held:${row.id}`, closed)
  try {
    await dropAiPending(row.organizationId, row.userId, row.id)
  } catch (error) {
    logger.warn("Removing an Allow notice failed", { error: errorText(error) })
  }
}

/** What closing a card needs to know */
const CLOSE_COLUMNS = {
  id: aiHeld.id,
  organizationId: aiHeld.organizationId,
  userId: aiHeld.userId,
  requestId: aiHeld.requestId,
  kind: aiHeld.kind,
}

/** Waiting cards past their time become expired. Scoped to one user when they read theirs, else every workspace */
export async function sweepHeld(scope?: { organizationId: string; userId: string }): Promise<number> {
  const due = and(eq(aiHeld.status, "waiting"), lte(aiHeld.expiresAt, utcNow))
  let rows: { id: string; organizationId: string; userId: string; requestId: string; kind: string }[]
  if (scope) {
    rows = await db
      .update(aiHeld)
      .set({ status: "expired" })
      .where(and(eq(aiHeld.organizationId, scope.organizationId), eq(aiHeld.userId, scope.userId), due))
      .returning(CLOSE_COLUMNS)
  } else {
    // tenancy: the sweep works across every workspace on purpose
    rows = await db.update(aiHeld).set({ status: "expired" }).where(due).returning(CLOSE_COLUMNS)
  }
  for (const row of rows) await closeHeld(row, "expired", null)
  return rows.length
}

/** The user's waiting cards from their DM with the AI, as a cleared chat closes them */
export async function dmCardsWaiting(viewer: { organizationId: string; userId: string }): Promise<string[]> {
  const rows = await db
    .select({ id: aiHeld.id })
    .from(aiHeld)
    .innerJoin(aiRequests, and(eq(aiRequests.id, aiHeld.requestId), eq(aiRequests.organizationId, viewer.organizationId)))
    .where(
      and(
        eq(aiHeld.organizationId, viewer.organizationId),
        eq(aiHeld.userId, viewer.userId),
        eq(aiHeld.status, "waiting"),
        eq(aiRequests.source, "ai"),
        sql`${aiRequests.place}->>'kind' = 'dm'`,
      ),
    )
  return rows.map((row) => row.id)
}

/** Closes these waiting cards of the user as expired */
export async function expireHeld(viewer: { organizationId: string; userId: string }, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const rows = await db
    .update(aiHeld)
    .set({ status: "expired", resume: null })
    .where(
      and(
        eq(aiHeld.organizationId, viewer.organizationId),
        eq(aiHeld.userId, viewer.userId),
        inArray(aiHeld.id, ids),
        eq(aiHeld.status, "waiting"),
      ),
    )
    .returning(CLOSE_COLUMNS)
  for (const row of rows) await closeHeld(row, "expired", null)
}

const BEAT_MS = 30_000
/** A request whose process wrote no heartbeat since then is taken as dead */
export const STALE_BEFORE = sql`now() - interval '2 minutes'`

/** Proves to every process that this one still works on the request, until the stop it gives back */
export function keepAlive(organizationId: string, requestId: string): () => void {
  const beat = () =>
    db
      .update(aiRequests)
      .set({ heartbeatAt: sql`now()` })
      .where(and(eq(aiRequests.id, requestId), eq(aiRequests.organizationId, organizationId)))
      .catch((error) => logger.warn("Writing an AI heartbeat failed", { error: errorText(error) }))
  void beat()
  const timer = setInterval(beat, BEAT_MS)
  timer.unref()
  return () => clearInterval(timer)
}

/** A card whose run stopped proving it is alive was cut off, so it closes as failed and nothing waits on it */
export async function failStaleAllowed(): Promise<void> {
  // tenancy: every workspace on purpose, a dead process leaves no card running anywhere
  const rows = await db
    .update(aiHeld)
    .set({ status: "failed", result: { error: RUN_FAILED } })
    .where(
      and(
        eq(aiHeld.status, "allowed"),
        sql`greatest(ai_held.answered_at at time zone 'utc', (select r.heartbeat_at from ai_requests r where r.id = ai_held.request_id)) < ${STALE_BEFORE}`,
      ),
    )
    .returning(CLOSE_COLUMNS)
  for (const row of rows) await closeHeld(row, "failed", null)
}

/** Who asked, through the AI or which agent */
async function originOf(organizationId: string, userId: string, requestId: string) {
  const [row] = await db
    .select({ source: aiRequests.source, tokenId: aiRequests.tokenId, place: aiRequests.place, tokenName: aiTokens.name })
    .from(aiRequests)
    .leftJoin(aiTokens, and(eq(aiTokens.id, aiRequests.tokenId), eq(aiTokens.organizationId, aiRequests.organizationId)))
    .where(and(eq(aiRequests.id, requestId), eq(aiRequests.organizationId, organizationId), eq(aiRequests.userId, userId)))
    .limit(1)
  return row ?? null
}

export async function listHeld(viewer: { userId: string; organizationId: string }) {
  await sweepHeld(viewer)
  const rows = await db
    .select({ held: aiHeld, source: aiRequests.source, place: aiRequests.place, tokenName: aiTokens.name })
    .from(aiHeld)
    .leftJoin(aiRequests, and(eq(aiRequests.id, aiHeld.requestId), eq(aiRequests.organizationId, aiHeld.organizationId)))
    .leftJoin(aiTokens, and(eq(aiTokens.id, aiRequests.tokenId), eq(aiTokens.organizationId, aiHeld.organizationId)))
    .where(and(eq(aiHeld.organizationId, viewer.organizationId), eq(aiHeld.userId, viewer.userId), eq(aiHeld.status, "waiting")))
    .orderBy(desc(aiHeld.createdAt))
  return rows.map((row) => heldDto(row.held, { source: row.source ?? "ai", tokenName: row.tokenName, place: row.place }))
}

type Origin = NonNullable<Awaited<ReturnType<typeof originOf>>>

const originVia = (origin: Origin): Via =>
  origin.source === "mcp" ? { kind: "agent", tokenId: origin.tokenId ?? "", tokenName: origin.tokenName ?? "Agent" } : { kind: "ai" }

/** Runs the allowed changes exactly as the card stored them, never through the gate again */
async function runChanges(asker: Asker, row: HeldRow, origin: Origin, items: HeldItem[]): Promise<HeldResult[]> {
  await stoppedFor(asker, origin)
  const via = originVia(origin)
  // A card is never held for a read in a shared place, so nothing here needs the place's members to filter by
  const ctx: ToolContext = {
    askerId: asker.userId,
    organizationId: asker.organizationId,
    isAdmin: asker.isAdmin,
    via,
    requestId: row.requestId,
    place: origin.place as Place,
    audience: null,
    scopes: null,
    signal: new AbortController().signal,
  }
  const log: ActivityEntry[] = []
  const results: HeldResult[] = []
  for (const item of items) {
    const def = toolByName(item.tool)
    if (!def) log.push({ tool: item.tool, result: "failed" })
    const result = def
      ? await runAndRecord({ ...ctx, members: item.members ?? null }, { def, args: item.args }, (entry) => log.push(entry))
      : FAILED
    results.push({ id: item.id, tool: item.tool, result })
  }
  const ran = new Set(items.map((item) => item.id))
  for (const item of row.items as HeldItem[]) {
    if (!ran.has(item.id)) log.push({ tool: item.tool, result: "denied", target: argTarget(item.args) })
  }
  await logActivity(ctx, log)
  return results
}

/**
 * "Share in chat" answers a share card. The AI teammate hears the card close and asks again in the place without
 * the place's filter, and on "Keep private" it asks again in the asker's DM
 */
async function runShare(asker: Asker, _row: HeldRow, origin: Origin, items: HeldItem[]): Promise<HeldResult[]> {
  await logActivity(
    { askerId: asker.userId, organizationId: asker.organizationId, via: originVia(origin) },
    items.map((item) => ({ tool: item.tool, result: "ok" as const })),
  )
  return items.map((item) => ({ id: item.id, tool: item.tool, result: { ok: true, data: { shared: true }, authors: [] } }))
}

/** "Allow" on a reply card posts the answer in the place, as the AI */
async function runReply(asker: Asker, _row: HeldRow, origin: Origin, items: HeldItem[]): Promise<HeldResult[]> {
  if (!replyPoster) throw new Error("Nothing posts AI replies")
  await stoppedFor(asker, origin)
  const results: HeldResult[] = []
  for (const item of items) {
    await replyPoster(asker, item.args as ReplyArgs)
    results.push({ id: item.id, tool: item.tool, result: { ok: true, data: null, authors: [] } })
  }
  await logActivity(
    { askerId: asker.userId, organizationId: asker.organizationId, via: originVia(origin) },
    items.map((item) => ({ tool: item.tool, result: "ok" as const })),
  )
  return results
}

/** What Allow does for each kind of card */
const ALLOW: Record<HeldKind, (asker: Asker, row: HeldRow, origin: Origin, items: HeldItem[]) => Promise<HeldResult[]>> = {
  changes: runChanges,
  share: runShare,
  reply: runReply,
}

const TAKE_REFUSALS: Record<TakeError, () => AiRefusal> = {
  gone: () => new AiRefusal(409, "This was already answered"),
  "timed-out": () => new AiRefusal(409, "This timed out"),
  "not-on-card": () => new AiRefusal(400, "That change isn't on this card"),
}

/** Only the asker answers. One atomic update decides, so a card is used once */
export async function answerHeld(asker: Asker, heldId: string, decision: "allow" | "deny", chosen?: string[]) {
  const [row] = await db
    .select()
    .from(aiHeld)
    .where(and(eq(aiHeld.id, heldId), eq(aiHeld.organizationId, asker.organizationId), eq(aiHeld.userId, asker.userId)))
    .limit(1)
  if (!row) throw new AiRefusal(404, "Not found")
  const allow = ALLOW[row.kind as HeldKind]
  if (!allow) throw new AiRefusal(409, "This card can't be answered here")
  const items = row.items as HeldItem[]
  const taken = takeBatch({ ...row, items }, decision === "allow" ? (chosen ?? items.map((item) => item.id)) : [], new Date())
  if ("error" in taken) {
    if (taken.error === "timed-out") await sweepHeld(asker)
    throw TAKE_REFUSALS[taken.error]()
  }
  const origin = await originOf(asker.organizationId, asker.userId, row.requestId)
  if (!origin) throw new AiRefusal(409, "This request has ended")

  const [claimed] = await db
    .update(aiHeld)
    .set({
      status: decision === "allow" ? "allowed" : "denied",
      chosen: decision === "allow" ? taken.run.map((item) => item.id) : null,
      answeredAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(aiHeld.id, row.id),
        eq(aiHeld.organizationId, asker.organizationId),
        eq(aiHeld.userId, asker.userId),
        eq(aiHeld.status, "waiting"),
        gt(aiHeld.expiresAt, utcNow),
      ),
    )
    .returning()
  if (!claimed) {
    // It may have run out between the check and the claim
    const [now] = await db
      .select({ status: aiHeld.status })
      .from(aiHeld)
      .where(and(eq(aiHeld.id, row.id), eq(aiHeld.organizationId, asker.organizationId)))
      .limit(1)
    if (now?.status === "waiting" || now?.status === "expired") {
      await sweepHeld(asker)
      throw TAKE_REFUSALS["timed-out"]()
    }
    throw TAKE_REFUSALS.gone()
  }

  const deny = async (close = true) => {
    await logActivity(
      { askerId: asker.userId, organizationId: asker.organizationId, via: originVia(origin) },
      items.map((item) => ({ tool: item.tool, result: "denied", target: argTarget(item.args) })),
    )
    if (close) await closeHeld(claimed, "denied", null, claimed.resume)
  }

  if (decision === "deny") {
    await deny()
    return { id: claimed.id, status: "denied" as const, results: null }
  }

  const stopBeat = keepAlive(asker.organizationId, claimed.requestId)
  try {
    const results = await allow(asker, claimed, origin, taken.run)
    // Only a card still allowed closes, so one that ai-stale already failed never goes on a second time
    const [done] = await db
      .update(aiHeld)
      .set({ status: "done", result: results, resume: null })
      .where(and(eq(aiHeld.id, claimed.id), eq(aiHeld.organizationId, asker.organizationId), eq(aiHeld.status, "allowed")))
      .returning({ id: aiHeld.id })
    if (!done) return { id: claimed.id, status: "failed" as const, results: null }
    await closeHeld(claimed, "done", results, claimed.resume)
    return { id: claimed.id, status: "done" as const, results }
  } catch (error) {
    // A refusal, such as the asker having left the place, closes the card as denied and says why
    if (error instanceof AgentStopped || error instanceof AiRefusal) {
      const [denied] = await db
        .update(aiHeld)
        .set({ status: "denied", chosen: null, resume: null })
        .where(and(eq(aiHeld.id, claimed.id), eq(aiHeld.organizationId, asker.organizationId), eq(aiHeld.status, "allowed")))
        .returning({ id: aiHeld.id })
      await deny(!!denied)
      throw new AiRefusal(409, error.message)
    }
    logger.error("Running allowed changes failed", error)
    // A card that broke while running is closed for good, never left allowed or run again
    const [failed] = await db
      .update(aiHeld)
      .set({ status: "failed", result: { error: RUN_FAILED }, resume: null })
      .where(and(eq(aiHeld.id, claimed.id), eq(aiHeld.organizationId, asker.organizationId), eq(aiHeld.status, "allowed")))
      .returning({ id: aiHeld.id })
    if (failed) await closeHeld(claimed, "failed", null, claimed.resume)
    return { id: claimed.id, status: "failed" as const, results: null }
  } finally {
    stopBeat()
  }
}
