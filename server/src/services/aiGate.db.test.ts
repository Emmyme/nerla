import { eq } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { aiHeld, aiRequests, db, tasks } from "../db"
import { testApp } from "../test/app"
import { makeProject, makeTask, makeUser, makeWorkspace, trashedDaysAgo } from "../test/factories"
import { TOO_MUCH_TRASH, TRASH_PER_REQUEST } from "../utils/aiGate"
import type { ToolContext } from "./aiTools/shared"
import { callTool } from "./aiGate"

let app: FastifyInstance

async function request(organizationId: string, userId: string): Promise<string> {
  const [row] = await db
    .insert(aiRequests)
    .values({ organizationId, userId, source: "ai", place: { kind: "dm" } })
    .returning({ id: aiRequests.id })
  return row.id
}

const contextOf = (organizationId: string, askerId: string, requestId: string, isAdmin = true): ToolContext => ({
  askerId,
  organizationId,
  isAdmin,
  via: { kind: "ai" },
  requestId,
  place: { kind: "dm" },
  audience: null,
  scopes: null,
  signal: new AbortController().signal,
})

beforeAll(async () => {
  app = await testApp()
})

afterAll(() => app.close())

describe("the AI's Trash changes", () => {
  it(`hold at most ${TRASH_PER_REQUEST} per request and refuse the rest, and a new request starts again`, async () => {
    const { orgId, adminId } = await makeWorkspace()
    const project = await makeProject(orgId, adminId)
    const taskIds = await Promise.all(Array.from({ length: TRASH_PER_REQUEST + 1 }, () => makeTask(orgId, { projectId: project })))
    const ctx = contextOf(orgId, adminId, await request(orgId, adminId))

    const outcomes = []
    for (const taskId of taskIds) outcomes.push(await callTool(ctx, "delete_task", { taskId }))

    expect(outcomes.slice(0, TRASH_PER_REQUEST).every((outcome) => "held" in outcome)).toBe(true)
    expect(outcomes[TRASH_PER_REQUEST]).toEqual({ ok: false, error: TOO_MUCH_TRASH })
    expect(await db.select().from(aiHeld).where(eq(aiHeld.requestId, ctx.requestId))).toHaveLength(TRASH_PER_REQUEST)

    const next = contextOf(orgId, adminId, await request(orgId, adminId))
    expect("held" in (await callTool(next, "delete_task", { taskId: taskIds[TRASH_PER_REQUEST] }))).toBe(true)
  })

  it("never counts against another user's request", async () => {
    const { orgId, adminId } = await makeWorkspace()
    const other = await makeWorkspace()
    const theirs = await request(other.orgId, other.adminId)
    const taskId = await makeTask(orgId, { projectId: await makeProject(orgId, adminId) })

    expect(await callTool(contextOf(orgId, adminId, theirs), "delete_task", { taskId })).toMatchObject({ ok: false })
    const [{ trashCount }] = await db.select({ trashCount: aiRequests.trashCount }).from(aiRequests).where(eq(aiRequests.id, theirs))
    expect(trashCount).toBe(0)
  })
})

describe("text another member may have written", () => {
  it("taints the request whether a read or a write hands it back", async () => {
    const { orgId, adminId } = await makeWorkspace()
    const asker = await makeUser(orgId)
    const projectId = await makeProject(orgId, adminId)
    const tainted = async (name: string, args: unknown) => {
      const ctx = contextOf(orgId, asker, await request(orgId, asker), false)
      expect(await callTool(ctx, name, args)).toMatchObject({ ok: true })
      const [row] = await db.select({ tainted: aiRequests.tainted }).from(aiRequests).where(eq(aiRequests.id, ctx.requestId))
      return row.tainted
    }

    // The asker's own task, but the project's name is its admin's
    const own = await makeTask(orgId, { projectId, assignedTo: asker })
    expect(await tainted("list_tasks", { projectId })).toBe(true)
    expect(await tainted("update_task", { taskId: own, status: "in_progress" })).toBe(true)

    const gone = await makeTask(orgId, { projectId, assignedTo: asker })
    await trashedDaysAgo("tasks", gone, 0)
    await db.update(tasks).set({ deletedBy: asker }).where(eq(tasks.id, gone))
    expect(await tainted("list_trash", { kind: "task" })).toBe(true)
  })
})
