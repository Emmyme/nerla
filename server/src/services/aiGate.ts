import { randomUUID } from "node:crypto"
import { and, sql } from "drizzle-orm"
import { z } from "zod"
import { aiRequests, db } from "../db"
import {
  effectiveStrictness,
  needsAllow,
  ONE_AT_A_TIME,
  TOO_MUCH_TRASH,
  TRASH_PER_REQUEST,
  TRASH_TOOLS,
  trashRefusals,
  type HeldItem,
} from "../utils/aiGate"
import { MAX_STEPS, MCP_PER_HOUR, SlidingCounter } from "../utils/aiLimits"
import type { Place, Strictness } from "../utils/aiTypes"
import { logger } from "../utils/logger"
import { tokenAllows } from "../utils/tokenScopes"
import { logActivity, type ActivityEntry } from "./aiActivity"
import { personalAi, workspaceAi } from "./aiSettings"
import { AppError } from "./acting"
import {
  APPLY_CHANGES,
  ASK_PRIVATE,
  POST_REPLY,
  SAVE_PREFERENCE,
  toolByName,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from "./aiTools"
import { areaOf, clip, KIND_AREAS, OWN_VIEW_REFUSAL } from "./aiTools/shared"
import { UUID } from "../utils/uuid"
import { errorText } from "../utils/errorText"
import { insertHeld, type HeldCard, type ReplyArgs } from "./aiCards"
import { argTarget, FAILED, markTainted, refused, requestWhere, runAndRecord, RUN_FAILED, type Note, type Prepared } from "./aiToolRun"

export type ToolOutcome = ToolResult | { held: HeldCard }

type Call = { name: string; args: unknown }
type Plan = { calls: Prepared[]; batch: boolean }

const HOUR_MS = 60 * 60 * 1000
const SUMMARY_MAX = 300

const mcpCalls = new SlidingCounter(MCP_PER_HOUR, HOUR_MS)

const SAVE_ALONE = "Call save_preference on its own"
const REMEMBER_LATER = "Offer to remember this after the other changes are done"

/** The log keeps a registry name, never a name a model made up */
const knownName = (name: string) => toolByName(name)?.name ?? "unknown"

/**
 * The one scope check. A batch passes here, since each of its changes is checked against its own tool. A "kinds"
 * tool is checked against the area its arguments name, and without arguments, as when it is listed, against any
 */
export function scopeAllows(ctx: ToolContext, def: ToolDef, args?: unknown): boolean {
  if (ctx.scopes === null || def.area === "both") return true
  const token = { scopes: ctx.scopes.areas, readOnly: ctx.scopes.readOnly, expiresAt: null, revokedAt: null }
  const now = new Date()
  if (def.area === "kinds" && args === undefined) return KIND_AREAS.some((area) => tokenAllows(token, area, def.write, now))
  const area = areaOf(def, args)
  return area !== null && area !== "both" && tokenAllows(token, area, def.write, now)
}

async function requestState(ctx: ToolContext) {
  if (!UUID.test(ctx.requestId)) return null
  const [row] = await db
    .select({ tainted: aiRequests.tainted, source: aiRequests.source, status: aiRequests.status, finishedAt: aiRequests.finishedAt })
    .from(aiRequests)
    .where(requestWhere(ctx, ctx.organizationId))
    .limit(1)
  return row ?? null
}

/** An AI turn stops at its step cap. An MCP session is capped per hour instead */
async function takeStep(ctx: ToolContext, source: string): Promise<boolean> {
  const [row] = await db
    .update(aiRequests)
    .set({ steps: sql`${aiRequests.steps} + 1` })
    .where(and(requestWhere(ctx, ctx.organizationId), source === "ai" ? sql`${aiRequests.steps} < ${MAX_STEPS}` : undefined))
    .returning({ steps: aiRequests.steps })
  return !!row
}

async function limitRefusal(ctx: ToolContext, source: string): Promise<string | null> {
  if (ctx.via.kind === "agent" && !mcpCalls.take(`${ctx.organizationId}:${ctx.askerId}`, Date.now())) {
    return "Too many calls, try again later."
  }
  return (await takeStep(ctx, source)) ? null : "This request has reached its step limit."
}

async function strictnessFor(ctx: ToolContext): Promise<Strictness> {
  const [org, personal] = await Promise.all([workspaceAi(ctx.organizationId), personalAi(ctx.askerId, ctx.organizationId)])
  return effectiveStrictness(org?.strictness ?? "tainted", personal?.strictness ?? null)
}

async function summaryOf(ctx: ToolContext, call: Prepared): Promise<string> {
  try {
    const text = call.def.summary ? (await call.def.summary(call.args, ctx)).trim() : ""
    // Each tool clips its own free text, so a cut here could only drop names the card shows nowhere else
    if (text) return text
  } catch (error) {
    logger.warn("An Allow summary failed", { tool: call.def.name, error: errorText(error) })
  }
  const target = argTarget(call.args)
  return target ? `${call.def.name} on ${target.kind} ${target.id}` : call.def.name
}

type Refusal = { error: string; result: "refused" | "failed" }

/** A tool's own check before anything is held. A row the asker can't reach answers "not found" */
async function precheckOf(ctx: ToolContext, call: Prepared, label = ""): Promise<Refusal | null> {
  if (!call.def.precheck) return null
  const said = (error: string) => (label ? `${label}: ${error}` : error)
  try {
    const error = await call.def.precheck(ctx, call.args)
    return error ? { error: said(error), result: "refused" } : null
  } catch (error) {
    if (error instanceof AppError)
      return { error: said(error.status === 403 || error.status === 404 ? "not found" : error.message), result: "refused" }
    logger.warn("A tool's check failed", { tool: call.def.name, error: errorText(error) })
    return { error: said(RUN_FAILED), result: "failed" }
  }
}

/** Checks a call without running it. A batch is checked change by change, each against its own tool */
async function planCall(ctx: ToolContext, call: Call): Promise<Plan | Refusal> {
  const def = toolByName(call.name)
  if (!def || def.internal || (def.aiOnly && ctx.via.kind !== "ai"))
    return { error: `There is no tool called ${call.name}`, result: "refused" }
  const parsed = def.input.safeParse(call.args ?? {})
  if (!parsed.success) return { error: z.prettifyError(parsed.error), result: "failed" }
  if (def.name !== APPLY_CHANGES) {
    if (!scopeAllows(ctx, def, parsed.data)) return { error: `This token can't use ${def.name}`, result: "refused" }
    if (def.ownView && ctx.audience?.some((id) => id !== ctx.askerId)) return { error: OWN_VIEW_REFUSAL, result: "refused" }
    const prepared = { def, args: parsed.data }
    return (await precheckOf(ctx, prepared)) ?? { calls: [prepared], batch: false }
  }
  const calls: Prepared[] = []
  for (const [index, change] of (parsed.data as { changes: { tool: string; args?: unknown }[] }).changes.entries()) {
    const label = `Change ${index + 1}`
    const inner = toolByName(change.tool)
    if (!inner || inner.internal || (inner.aiOnly && ctx.via.kind !== "ai"))
      return { error: `${label}: there is no tool called ${change.tool}`, result: "refused" }
    if (inner.name === APPLY_CHANGES) return { error: `${label}: ${APPLY_CHANGES} can't hold another ${APPLY_CHANGES}`, result: "refused" }
    if (!inner.write) return { error: `${label}: ${inner.name} changes nothing, so call it on its own`, result: "refused" }
    if (TRASH_TOOLS.includes(inner.name)) return { error: ONE_AT_A_TIME, result: "refused" }
    if (inner.name === SAVE_PREFERENCE) return { error: SAVE_ALONE, result: "refused" }
    const args = inner.input.safeParse(change.args ?? {})
    if (!args.success) return { error: `${label}: ${z.prettifyError(args.error)}`, result: "failed" }
    if (!scopeAllows(ctx, inner, args.data)) return { error: `${label}: this token can't use ${inner.name}`, result: "refused" }
    const prepared = { def: inner, args: args.data }
    const refusal = await precheckOf(ctx, prepared, label)
    if (refusal) return refusal
    calls.push(prepared)
  }
  return { calls, batch: true }
}

async function othersCanSee(ctx: ToolContext, call: Prepared): Promise<boolean> {
  if (!call.def.othersCanSee) return true
  try {
    return await call.def.othersCanSee(ctx, call.args)
  } catch {
    return true
  }
}

/** Whether one change waits for Allow. Who can see it is only worked out when it could change the answer */
async function gated(ctx: ToolContext, call: Prepared, strictness: Strictness, tainted: boolean): Promise<boolean> {
  let alwaysGated: boolean
  try {
    alwaysGated = (await call.def.alwaysGated?.(call.args, ctx)) ?? false
  } catch {
    alwaysGated = true
  }
  const asks = (seen: boolean) => needsAllow({ write: call.def.write, alwaysGated, strictness, tainted, othersCanSee: seen })
  if (asks(false) === asks(true)) return asks(false)
  return asks(await othersCanSee(ctx, call))
}

/** A batch that ran answers with each change's own result */
function batchResult(results: ToolResult[], calls: Prepared[]): ToolResult {
  if (results.every((result) => !result.ok)) {
    return refused(results.map((result, index) => `Change ${index + 1}: ${result.ok ? "" : result.error}`).join("\n"))
  }
  return {
    ok: true,
    data: {
      results: results.map((result, index) =>
        result.ok
          ? { tool: calls[index].def.name, ok: true, data: result.data }
          : { tool: calls[index].def.name, ok: false, error: result.error },
      ),
    },
    authors: results.flatMap((result) => (result.ok ? result.authors : [])),
  }
}

async function hold(ctx: ToolContext, calls: Prepared[], note: Note): Promise<HeldCard> {
  const items: HeldItem[] = await Promise.all(
    calls.map(async (call) => ({
      id: randomUUID(),
      tool: call.def.name,
      args: call.args,
      summary: await summaryOf(ctx, call),
      ...(ctx.place.kind === "group" && ctx.audience ? { members: ctx.audience } : {}),
    })),
  )
  const card = await insertHeld(ctx, "changes", items)
  for (const call of calls) note({ tool: call.def.name, result: "held", target: argTarget(call.args) })
  return card
}

/** Whether a request may still hold a card */
const stillRunning = (ctx: ToolContext, request: Awaited<ReturnType<typeof requestState>>) =>
  !ctx.signal.aborted && !!request && request.status === "running" && !request.finishedAt

/** Takes one of the request's trash changes, or false once it has held them all */
async function takeTrash(ctx: ToolContext): Promise<boolean> {
  const [row] = await db
    .update(aiRequests)
    .set({ trashCount: sql`${aiRequests.trashCount} + 1` })
    .where(and(requestWhere(ctx, ctx.organizationId), sql`${aiRequests.trashCount} < ${TRASH_PER_REQUEST}`))
    .returning({ id: aiRequests.id })
  return !!row
}

/** Every change counts toward the hourly cap and the step count, a batch's changes each on their own */
async function limitFor(ctx: ToolContext, source: string, changes: number): Promise<string | null> {
  for (let taken = 0; taken < changes; taken++) {
    const limited = await limitRefusal(ctx, source)
    if (limited) return limited
  }
  return null
}

async function gate(ctx: ToolContext, calls: Call[], outcomes: (ToolOutcome | undefined)[], note: Note): Promise<void> {
  const request = await requestState(ctx)
  if (!request) {
    calls.forEach((call, index) => {
      outcomes[index] = refused("This request has ended")
      note({ tool: knownName(call.name), result: "refused" })
    })
    return
  }
  // In a shared place the context already holds other users' words
  if (ctx.audience && !request.tainted) await markTainted(ctx)

  const plans: (Plan | undefined)[] = []
  const oneAtATime = new Set(trashRefusals(calls.map((call) => call.name)))
  for (const [index, call] of calls.entries()) {
    // The steps are taken before planning, so a request at its cap never runs a precheck such as a whole board's load
    const changes = call.name === APPLY_CHANGES ? (call.args as { changes?: unknown }).changes : undefined
    const limited = await limitFor(ctx, request.source, Array.isArray(changes) ? Math.max(1, changes.length) : 1)
    const plan: Plan | Refusal = limited
      ? { error: limited, result: "refused" }
      : oneAtATime.has(index)
        ? { error: ONE_AT_A_TIME, result: "refused" }
        : await planCall(ctx, call)
    if ("error" in plan) {
      outcomes[index] = refused(plan.error)
      note({ tool: knownName(call.name), result: plan.result, target: argTarget(call.args) })
    } else {
      plans[index] = plan
    }
  }

  const strictness = await strictnessFor(ctx)
  const card: { index: number; call: Prepared }[] = []

  // A read is free unless its tool is always gated
  const reads: number[] = []
  for (const [index, plan] of plans.entries()) {
    if (!plan || plan.batch || plan.calls[0].def.write) continue
    reads.push(index)
    if (!(await gated(ctx, plan.calls[0], strictness, true))) continue
    // An allowed read runs without the place's members to filter by, so a shared place can't hold one
    if (ctx.audience) {
      outcomes[index] = refused("This can't be looked up here")
      note({ tool: plan.calls[0].def.name, result: "refused", target: argTarget(plan.calls[0].args) })
    } else {
      card.push({ index, call: plan.calls[0] })
    }
  }
  const freeReads = reads.filter((index) => !outcomes[index] && !card.some((entry) => entry.index === index))
  await Promise.all(freeReads.map(async (index) => (outcomes[index] = await runAndRecord(ctx, plans[index]!.calls[0], note))))

  // Read again, since this request's own reads, and any other call of it running alongside, may have tainted it
  const fresh = await requestState(ctx)
  const tainted = !!ctx.audience || !fresh || fresh.tainted

  const free: number[] = []
  for (const [index, plan] of plans.entries()) {
    if (!plan || reads.includes(index)) continue
    const needs = await Promise.all(plan.calls.map((call) => gated(ctx, call, strictness, tainted)))
    if (!needs.some(Boolean)) free.push(index)
    // A batch is shown whole on the card once any of its changes needs Allow
    else plan.calls.forEach((call, at) => (plan.batch || needs[at]) && card.push({ index, call }))
  }

  for (const index of free) {
    const plan = plans[index]!
    const results: ToolResult[] = []
    for (const call of plan.calls) results.push(await runAndRecord(ctx, call, note))
    outcomes[index] = plan.batch ? batchResult(results, plan.calls) : results[0]
  }

  if (card.length === 0) return
  if (!stillRunning(ctx, fresh)) {
    for (const { index, call } of card) {
      outcomes[index] = refused("This request has ended")
      note({ tool: call.def.name, result: "refused", target: argTarget(call.args) })
    }
    return
  }
  // A Remember card holds one line and nothing else, so its yes is a yes to that line alone
  const others = card.some((entry) => entry.call.def.name !== SAVE_PREFERENCE)
  let remembering = false
  for (const entry of [...card]) {
    if (entry.call.def.name !== SAVE_PREFERENCE) continue
    if (!others && !remembering) {
      remembering = true
      continue
    }
    outcomes[entry.index] = refused(REMEMBER_LATER)
    note({ tool: SAVE_PREFERENCE, result: "refused" })
    card.splice(card.indexOf(entry), 1)
  }
  for (const entry of [...card]) {
    if (!TRASH_TOOLS.includes(entry.call.def.name) || (await takeTrash(ctx))) continue
    outcomes[entry.index] = refused(TOO_MUCH_TRASH)
    note({ tool: entry.call.def.name, result: "refused", target: argTarget(entry.call.args) })
    card.splice(card.indexOf(entry), 1)
  }
  if (card.length === 0) return
  const held = await hold(
    ctx,
    card.map((entry) => entry.call),
    note,
  )
  for (const { index } of card) outcomes[index] = { held }
}

/**
 * The gate for the parallel calls of one model turn: free calls run, and every call that needs Allow goes on
 * one shared card. Reads run first, so the taint they bring counts for the writes beside them
 */
export async function holdBatch(ctx: ToolContext, calls: Call[]): Promise<ToolOutcome[]> {
  const outcomes: (ToolOutcome | undefined)[] = calls.map(() => undefined)
  const log: ActivityEntry[] = []
  const note: Note = (entry) => log.push(entry)
  try {
    await gate(ctx, calls, outcomes, note)
  } catch (error) {
    logger.error("The AI gate failed", error)
    calls.forEach((call, index) => {
      if (outcomes[index]) return
      outcomes[index] = FAILED
      note({ tool: knownName(call.name), result: "failed" })
    })
  }
  await logActivity(ctx, log)
  return outcomes.map((outcome) => outcome ?? FAILED)
}

/** What a share card keeps, so either answer can ask again without anything held in memory */
export type ShareArgs = { reason: string; prompt: string; place: Place; replyTo: { messageId: string } | null }

/**
 * The private card: in a shared place, the asker alone chooses whether their own things may answer there. It
 * counts as a step and is logged like any held call
 */
export async function holdShare(ctx: ToolContext, args: ShareArgs): Promise<ToolOutcome> {
  const log: ActivityEntry[] = []
  let outcome: ToolOutcome
  try {
    const request = await requestState(ctx)
    const open = ctx.via.kind === "ai" && !!ctx.audience && stillRunning(ctx, request)
    const limited = open ? await limitRefusal(ctx, request!.source) : "This request has ended"
    if (limited) {
      outcome = refused(limited)
      log.push({ tool: ASK_PRIVATE, result: "refused" })
    } else {
      const summary = `Use your own things to answer: ${clip(args.reason, SUMMARY_MAX - 40)}`
      outcome = { held: await insertHeld(ctx, "share", [{ id: randomUUID(), tool: ASK_PRIVATE, args, summary }]) }
      log.push({ tool: ASK_PRIVATE, result: "held" })
    }
  } catch (error) {
    logger.error("Holding a private card failed", error)
    outcome = FAILED
    log.push({ tool: ASK_PRIVATE, result: "failed" })
  }
  await logActivity(ctx, log)
  return outcome
}

/**
 * After "Share in chat" the answer is drawn from the asker's own things, so it waits on a card before anyone else
 * reads it. Allow posts it exactly as the card shows it
 */
export async function holdReply(ctx: ToolContext, args: ReplyArgs, placeName: string): Promise<HeldCard | null> {
  const request = await requestState(ctx)
  if (ctx.via.kind !== "ai" || !stillRunning(ctx, request)) return null
  const summary = `Post this answer in ${clip(placeName, 80)}`
  const card = await insertHeld(ctx, "reply", [{ id: randomUUID(), tool: POST_REPLY, args, summary }])
  await logActivity(ctx, [{ tool: POST_REPLY, result: "held" }])
  return card
}

/** The only way MCP and the AI teammate run a tool */
export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolOutcome> {
  const [outcome] = await holdBatch(ctx, [{ name, args }])
  return outcome
}
