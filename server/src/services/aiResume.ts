/** What happens after an Allow card closes: the paused turn goes on, asks again, or tells the asker */
import { and, eq } from "drizzle-orm"
import { aiHeld, aiMessages, aiRequests, db, organizationMembers } from "../db"
import type { HeldItem } from "../utils/aiGate"
import { ACTIONS_MAX, actionsOf } from "../utils/aiActions"
import { madeOf } from "../utils/aiReply"
import type { AiAction, Place } from "../utils/aiTypes"
import { logger } from "../utils/logger"
import type { ShareArgs } from "./aiGate"
import { onHeldClosed, onReplyAllowed, tell, type Asker, type HeldClosed, type ReplyArgs } from "./aiCards"
import { placeName } from "./aiPlaces"
import { AiRefusal } from "./aiSettings"
import { errorText } from "../utils/errorText"
import { aiMessageDto, threadIdOf } from "./aiThread"
import {
  audienceOf,
  begin,
  fresh,
  isShared,
  modelIn,
  NOT_AVAILABLE,
  type Paused,
  paused,
  postInPlace,
  type ReplyTo,
  RESUME_V,
  type Run,
  shownResult,
  toolMessage,
} from "./aiTurn"

const LEFT_PLACE = "You're no longer in that place, so nothing more was done."

const strings = (value: unknown) => Array.isArray(value) && value.every((entry) => typeof entry === "string")

/** The card's paused turn, or null when it has none or it is from an older shape */
function resumeOf(value: unknown): Paused | null {
  const stored = value as (Paused & { v?: unknown }) | null
  if (!stored || typeof stored !== "object" || stored.v !== RESUME_V) return null
  const { run } = stored
  const fits =
    !!run &&
    typeof run === "object" &&
    typeof run.asker?.userId === "string" &&
    typeof run.prompt === "string" &&
    !!run.place &&
    Array.isArray(run.actions) &&
    Array.isArray(run.made) &&
    Array.isArray(stored.messages) &&
    strings(stored.pending) &&
    strings(stored.tools) &&
    typeof stored.requestId === "string"
  return fits ? { run, messages: stored.messages, pending: stored.pending, tools: stored.tools, requestId: stored.requestId } : null
}

async function askerOf(organizationId: string, userId: string): Promise<Asker | null> {
  const [row] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    .limit(1)
  return row ? { userId, organizationId, isAdmin: row.role === "admin" } : null
}

async function requestTainted(organizationId: string, userId: string, requestId: string): Promise<boolean> {
  const [row] = await db
    .select({ tainted: aiRequests.tainted })
    .from(aiRequests)
    .where(and(eq(aiRequests.id, requestId), eq(aiRequests.organizationId, organizationId), eq(aiRequests.userId, userId)))
    .limit(1)
  // A request that can't be found counts as tainted
  return row?.tainted ?? true
}

/** What the asker's answer to a card tells the model. In a shared place a write says only whether it worked */
function answerText(closed: HeldClosed, shared: boolean): string {
  if (closed.status === "denied") return JSON.stringify({ ok: false, error: "The user denied this, so it didn't run" })
  if (closed.status !== "done" || !closed.results) return JSON.stringify({ ok: false, error: "Something went wrong, so it didn't run" })
  return JSON.stringify({
    answered: "allowed",
    results: closed.results.map((entry) => ({
      tool: entry.tool,
      result: JSON.parse(shownResult(entry.tool, entry.result, shared)) as unknown,
    })),
  })
}

/** What a changes card did, for the DM answer that comes after it */
function cardActions(closed: HeldClosed, tools: string[]): AiAction[] {
  if (closed.status === "done" && closed.results) return closed.results.flatMap((entry) => actionsOf(entry.tool, entry.result, true))
  const error = closed.status === "denied" ? "The user denied this, so it didn't run" : "Something went wrong, so it didn't run"
  return tools.map((tool) => ({ tool, ok: false, error }))
}

/** A card that expired unanswered. The DM's next turn is told nothing ran, along with anything done before the card */
async function keepExpired(closed: HeldClosed, state: Paused) {
  if (isShared(state.run.place)) return
  const threadId = await threadIdOf(closed.organizationId, closed.userId)
  const error = "Allow expired, so it didn't run"
  await db.insert(aiMessages).values({
    organizationId: closed.organizationId,
    threadId,
    role: "assistant",
    content: "",
    status: "done",
    requestId: state.requestId,
    actions: [...state.run.actions, ...state.tools.map((tool) => ({ tool, ok: false, error }))].slice(-ACTIONS_MAX),
  })
}

/** A turn that can't go on after a card. The asker hears it on the card's request */
function cantGoOn(closed: HeldClosed, reason: string) {
  tell(closed.organizationId, closed.userId, { type: "ai-request", requestId: closed.requestId, status: "failed", reason })
}

/** Starts the next turn after a card, or tells the asker why it can't */
async function goOn(closed: HeldClosed, run: Run): Promise<{ requestId: string } | null> {
  try {
    return await begin(run)
  } catch (error) {
    if (!(error instanceof AiRefusal)) throw error
    cantGoOn(closed, error.message)
    return null
  }
}

const RESTARTED =
  "I was restarted while this card waited, so I can't pick up where I left off. The changes you allowed are done. Ask me again for the rest."

/** A note from the AI in the asker's DM, on the card's request */
async function noteInDm(closed: HeldClosed, content: string) {
  const threadId = await threadIdOf(closed.organizationId, closed.userId)
  const [message] = await db
    .insert(aiMessages)
    .values({ organizationId: closed.organizationId, threadId, role: "assistant", content, status: "done", requestId: closed.requestId })
    .returning()
  tell(closed.organizationId, closed.userId, { type: "ai-message", message: aiMessageDto(message) })
}

/** A changes card closed: the turn goes on in a fresh request that keeps the taint, from memory or else from the card */
async function changesAnswered(closed: HeldClosed) {
  const [row] = await db
    .select({ resume: aiHeld.resume, source: aiRequests.source })
    .from(aiHeld)
    .innerJoin(aiRequests, and(eq(aiRequests.id, aiHeld.requestId), eq(aiRequests.organizationId, closed.organizationId)))
    .where(and(eq(aiHeld.id, closed.id), eq(aiHeld.organizationId, closed.organizationId)))
    .limit(1)
  await db
    .update(aiHeld)
    .set({ resume: null })
    .where(and(eq(aiHeld.id, closed.id), eq(aiHeld.organizationId, closed.organizationId)))
  const state = paused.get(closed.id) ?? resumeOf(closed.resume ?? row?.resume)
  paused.delete(closed.id)
  if (!state) {
    // An agent's card goes on in the agent, and a card that ran nothing has nothing to tell
    if (row?.source === "ai" && closed.status === "done") await noteInDm(closed, RESTARTED)
    return
  }
  if (closed.status === "expired") return keepExpired(closed, state)
  const asker = await askerOf(closed.organizationId, closed.userId)
  if (!asker || asker.userId !== state.run.asker.userId) return cantGoOn(closed, LEFT_PLACE)
  const shared = isShared(state.run.place)
  let audience = state.run.audience
  let large = state.run.large
  if (shared) {
    // The place may have changed while the card waited, and the asker may have left it
    const found = await audienceOf(asker, state.run.place)
    if (!found) return cantGoOn(closed, LEFT_PLACE)
    if (audience) {
      audience = found.audience
      large = found.large
    }
  }
  const text = answerText(closed, shared)
  const answers = state.pending.map((id, index) =>
    toolMessage(id, "allow answer", index === 0 ? text : JSON.stringify({ note: "Answered on the same card as the call before" })),
  )
  const tainted = await requestTainted(closed.organizationId, closed.userId, state.requestId)
  const actions = [...state.run.actions, ...cardActions(closed, state.tools)]
  const made = (closed.status === "done" ? (closed.results ?? []) : []).flatMap((entry) => {
    const found = entry.result.ok ? madeOf(entry.result.data) : null
    return found ? [found] : []
  })
  await goOn(closed, {
    ...state.run,
    asker,
    audience,
    large,
    tainted,
    countAsk: false,
    resume: [...state.messages, ...answers],
    actions,
    made: [...state.run.made, ...made],
  })
}

const placeShape = (value: unknown): value is Place => {
  const place = value as Place | null
  if (!place || typeof place !== "object") return false
  if (place.kind === "group") return typeof place.id === "string"
  if (place.kind === "task_comment") return typeof place.taskId === "string"
  if (place.kind === "doc_comment") return typeof place.fileId === "string" && typeof place.commentId === "string"
  return false
}

/** A share card closed: "Share in chat" asks again in the place for everyone, "Keep private" asks again in the DM */
async function shareAnswered(closed: HeldClosed) {
  if (closed.status !== "done" && closed.status !== "denied") return
  const [row] = await db
    .select({ items: aiHeld.items })
    .from(aiHeld)
    .where(and(eq(aiHeld.id, closed.id), eq(aiHeld.organizationId, closed.organizationId), eq(aiHeld.userId, closed.userId)))
    .limit(1)
  const args = ((row?.items ?? []) as HeldItem[])[0]?.args as Partial<ShareArgs> | undefined
  if (!args || typeof args.prompt !== "string" || !placeShape(args.place)) return
  const asker = await askerOf(closed.organizationId, closed.userId)
  if (!asker) return cantGoOn(closed, LEFT_PLACE)
  const found = await audienceOf(asker, args.place)
  if (closed.status === "done") {
    if (!found) return cantGoOn(closed, LEFT_PLACE)
    await goOn(closed, { ...fresh(asker, args.place, args.prompt), replyTo: replyOf(args.replyTo), countAsk: false })
    return
  }
  if (!(await modelIn(asker, { kind: "dm" }))) return cantGoOn(closed, NOT_AVAILABLE)
  const threadId = await threadIdOf(asker.organizationId, asker.userId)
  const [message] = await db
    .insert(aiMessages)
    .values({ organizationId: asker.organizationId, threadId, role: "user", content: args.prompt, status: "done" })
    .returning()
  tell(asker.organizationId, asker.userId, { type: "ai-message", message: aiMessageDto(message) })
  const started = await goOn(closed, {
    ...fresh(asker, { kind: "dm" }, args.prompt),
    askedIn: found ? args.place : null,
    promptId: message.id,
    tainted: true,
    countAsk: false,
  })
  if (!started) return
  await db
    .update(aiMessages)
    .set({ requestId: started.requestId })
    .where(and(eq(aiMessages.id, message.id), eq(aiMessages.organizationId, asker.organizationId)))
}

const replyOf = (value: unknown): ReplyTo | null => {
  const replyTo = value as ReplyTo | null | undefined
  return replyTo && typeof replyTo.messageId === "string" ? { messageId: replyTo.messageId } : null
}

/** Allow on a reply card posts the answer, while the asker is still in the place */
onReplyAllowed(async (asker, args) => {
  if (!placeShape(args?.place) || typeof args.content !== "string" || !args.content) throw new Error("The card holds no answer")
  if (!(await audienceOf(asker, args.place))) throw new AiRefusal(409, LEFT_PLACE)
  await postInPlace(asker, args.place, replyOf(args.replyTo), args.content)
})

/** A reply card closed without posting: the asker hears it in their DM */
async function replyAnswered(closed: HeldClosed) {
  if (closed.status !== "denied" && closed.status !== "expired") return
  const [row] = await db
    .select({ items: aiHeld.items })
    .from(aiHeld)
    .where(and(eq(aiHeld.id, closed.id), eq(aiHeld.organizationId, closed.organizationId), eq(aiHeld.userId, closed.userId)))
    .limit(1)
  const args = ((row?.items ?? []) as HeldItem[])[0]?.args as Partial<ReplyArgs> | undefined
  const where = placeShape(args?.place) ? await placeName(args.place, closed.organizationId) : "that place"
  await noteInDm(closed, `Nothing was posted in ${where}.`)
}

onHeldClosed((closed: HeldClosed) => {
  const next = closed.kind === "share" ? shareAnswered(closed) : closed.kind === "reply" ? replyAnswered(closed) : changesAnswered(closed)
  next.catch((error) => logger.warn("Going on after an Allow card failed", { error: errorText(error) }))
})
