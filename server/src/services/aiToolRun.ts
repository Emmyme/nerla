/** Running one tool call for the AI or an agent, recording its taint and log entry */
import { and, eq } from "drizzle-orm"
import { aiRequests, db } from "../db"
import { isTainting } from "../utils/aiGate"
import type { ItemRef } from "../utils/aiTypes"
import { logger } from "../utils/logger"
import type { ActivityEntry } from "./aiActivity"
import { runTool, type ToolContext, type ToolDef, type ToolResult } from "./aiTools"

export type Prepared = { def: ToolDef; args: unknown }
export type Note = (entry: ActivityEntry) => void

const TRASH_KINDS = new Set(["task", "event", "doc", "file", "project"])

export const RUN_FAILED = "Something went wrong"
export const refused = (error: string): ToolResult => ({ ok: false, error })
export const FAILED = refused(RUN_FAILED)

export const requestWhere = (ctx: ToolContext, organizationId: string) =>
  and(eq(aiRequests.id, ctx.requestId), eq(aiRequests.organizationId, organizationId), eq(aiRequests.userId, ctx.askerId))

/** Taint lives on the request and never clears */
export const markTainted = (ctx: ToolContext) => db.update(aiRequests).set({ tainted: true }).where(requestWhere(ctx, ctx.organizationId))

/** What a call will change, from its arguments, for the log and a summary that couldn't be made */
export function argTarget(args: unknown): ItemRef | null {
  const record = (args ?? {}) as Record<string, unknown>
  const id = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : null)
  if (id("taskId")) return { kind: "task", id: id("taskId")! }
  if (id("fileId")) return { kind: "doc", id: id("fileId")! }
  if (id("eventId")) return { kind: "event", id: id("eventId")! }
  if (id("id") && (record.kind === "group" || record.kind === "dm"))
    return { kind: record.kind === "dm" ? "person" : "chat", id: id("id")! }
  if (id("projectId")) return { kind: "project", id: id("projectId")! }
  if (id("id") && typeof record.kind === "string" && TRASH_KINDS.has(record.kind))
    return { kind: record.kind as ItemRef["kind"], id: id("id")! }
  return null
}

/** Runs a call and records its taint before the result can reach anyone */
export async function runAndRecord(ctx: ToolContext, call: Prepared, note: Note): Promise<ToolResult> {
  const result = await runTool(ctx, call.def.name, call.args)
  if (result.ok && isTainting(result.authors, ctx.askerId)) {
    try {
      await markTainted(ctx)
    } catch (error) {
      logger.error("Recording taint failed", error)
      note({ tool: call.def.name, result: "failed", target: result.target })
      return FAILED
    }
  }
  note({ tool: call.def.name, result: result.ok ? "ok" : "failed", target: result.ok ? result.target : argTarget(call.args) })
  return result
}
