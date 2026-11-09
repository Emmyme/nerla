import { and, desc, eq } from "drizzle-orm"
import { aiActivity, aiTokens, aiUsage, db, users } from "../db"
import { budgetState } from "../utils/aiLimits"
import type { ItemRef, Via } from "../utils/aiTypes"
import { logger } from "../utils/logger"
import { presenceName } from "../utils/presence"
import { workspaceAi } from "./aiSettings"
import { toolByName } from "./aiTools"
import { monthOf } from "./aiModel"
import { UUID } from "../utils/uuid"
import { errorText } from "../utils/errorText"

export type ActivityResult = "ok" | "refused" | "held" | "denied" | "failed"

/** One tool call. Never any of its content */
export type ActivityEntry = { tool: string; result: ActivityResult; target?: ItemRef | null }

const SHOWN = 200

export const sourceOf = (via: Via): "ai" | "mcp" => (via.kind === "agent" ? "mcp" : "ai")

/** A failure to log is reported and never fails the call */
export async function logActivity(asker: { askerId: string; organizationId: string; via: Via }, entries: ActivityEntry[]): Promise<void> {
  if (entries.length === 0) return
  const tokenId = asker.via.kind === "agent" && UUID.test(asker.via.tokenId) ? asker.via.tokenId : null
  try {
    await db.insert(aiActivity).values(
      entries.map((entry) => ({
        organizationId: asker.organizationId,
        userId: asker.askerId,
        source: sourceOf(asker.via),
        tokenId,
        // Only a name from the registry is stored, never what a model sent
        tool: toolByName(entry.tool)?.name ?? "unknown",
        targetKind: entry.target?.kind ?? null,
        targetId: entry.target && UUID.test(entry.target.id) ? entry.target.id : null,
        result: entry.result,
      })),
    )
  } catch (error) {
    logger.warn("Logging AI activity failed", { error: errorText(error) })
  }
}

/** The newest rows: the viewer's own, or the whole workspace's for an admin */
export async function listActivity(viewer: { userId: string; organizationId: string }, scope: "mine" | "workspace") {
  const rows = await db
    .select({
      id: aiActivity.id,
      userId: aiActivity.userId,
      firstName: users.firstName,
      lastName: users.lastName,
      source: aiActivity.source,
      tokenId: aiActivity.tokenId,
      tokenName: aiTokens.name,
      tool: aiActivity.tool,
      targetKind: aiActivity.targetKind,
      targetId: aiActivity.targetId,
      result: aiActivity.result,
      createdAt: aiActivity.createdAt,
    })
    .from(aiActivity)
    .leftJoin(users, eq(users.id, aiActivity.userId))
    .leftJoin(aiTokens, and(eq(aiTokens.id, aiActivity.tokenId), eq(aiTokens.organizationId, aiActivity.organizationId)))
    .where(and(eq(aiActivity.organizationId, viewer.organizationId), scope === "mine" ? eq(aiActivity.userId, viewer.userId) : undefined))
    .orderBy(desc(aiActivity.createdAt), desc(aiActivity.id))
    .limit(SHOWN)
  return rows.map(({ firstName, lastName, ...row }) => ({ ...row, userName: presenceName(firstName, lastName) }))
}

/** This month's tokens: the viewer's own, and for an admin everyone's against the workspace budget */
export async function usageSummary(viewer: { userId: string; organizationId: string; isAdmin: boolean }) {
  const month = monthOf()
  const [org, rows] = await Promise.all([
    workspaceAi(viewer.organizationId),
    db
      .select({
        userId: aiUsage.userId,
        firstName: users.firstName,
        lastName: users.lastName,
        tokens: aiUsage.tokens,
        personal: aiUsage.personal,
      })
      .from(aiUsage)
      .leftJoin(users, eq(users.id, aiUsage.userId))
      .where(
        and(
          eq(aiUsage.organizationId, viewer.organizationId),
          eq(aiUsage.month, month),
          viewer.isAdmin ? undefined : eq(aiUsage.userId, viewer.userId),
        ),
      ),
  ])
  const total = (list: typeof rows, personal: boolean) =>
    list.filter((row) => row.personal === personal).reduce((sum, row) => sum + Number(row.tokens), 0)
  const mine = rows.filter((row) => row.userId === viewer.userId)
  const used = total(mine, false)
  const personBudget = org?.personBudget ?? null
  const people = [...new Set(rows.map((row) => row.userId))].map((userId) => {
    const theirs = rows.filter((row) => row.userId === userId)
    return {
      userId,
      name: presenceName(theirs[0].firstName, theirs[0].lastName),
      used: total(theirs, false),
      personalUsed: total(theirs, true),
    }
  })
  const workspaceUsed = total(rows, false)
  const monthlyBudget = org?.monthlyBudget ?? null
  return {
    month,
    used,
    personalUsed: total(mine, true),
    personBudget,
    reached: budgetState(used, personBudget) === "reached",
    workspace: viewer.isAdmin
      ? { used: workspaceUsed, monthlyBudget, reached: budgetState(workspaceUsed, monthlyBudget) === "reached", people }
      : null,
  }
}
