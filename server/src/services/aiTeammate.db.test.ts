import { and, eq, inArray, ne, sql } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { aiHeld, aiMessages, aiRequests, aiSettings, db } from "../db"
import { live } from "../live/live"
import { testApp } from "../test/app"
import { makeProject, makeTask, makeWorkspace } from "../test/factories"
import type { StreamEvent } from "../utils/modelStream"
import { answerHeld } from "./aiCards"
import { askInDm, endStaleAi, forgetPausedForTests } from "./aiTeammate"
import { threadIdOf } from "./aiThread"

const model = vi.hoisted(() => ({ turns: [] as StreamEvent[][] }))
vi.mock("./aiModel", async (original) => ({
  ...(await original<typeof import("./aiModel")>()),
  streamChat: async function* () {
    yield* model.turns.shift() ?? []
  },
}))

let app: FastifyInstance

beforeAll(async () => {
  app = await testApp()
})

afterAll(() => app.close())

describe("AI work across processes", () => {
  it("a second process starting leaves live AI work alone, and a dead one's work ends within two minutes", async () => {
    const { orgId, adminId } = await makeWorkspace()
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const request = async (source: "ai" | "mcp", beat: number | null, createdAt = minutesAgo(0)) => {
      const [row] = await db
        .insert(aiRequests)
        .values({
          organizationId: orgId,
          userId: adminId,
          source,
          place: source === "ai" ? { kind: "dm" } : { kind: "mcp" },
          createdAt,
          heartbeatAt: beat === null ? null : sql`now() - ${beat} * interval '1 minute'`,
        })
        .returning({ id: aiRequests.id })
      return row.id
    }
    const card = async (requestId: string, answeredAt: string) => {
      const [row] = await db
        .insert(aiHeld)
        .values({
          organizationId: orgId,
          userId: adminId,
          requestId,
          kind: "changes",
          items: [],
          status: "allowed",
          expiresAt: minutesAgo(-10),
          answeredAt,
        })
        .returning({ id: aiHeld.id })
      return row.id
    }
    const liveAi = await request("ai", 0.5)
    const liveMcp = await request("mcp", 0)
    const deadAi = await request("ai", 3)
    const deadMcp = await request("mcp", null, minutesAgo(3))
    const liveCard = await card(liveMcp, minutesAgo(3))
    const deadCard = await card(deadAi, minutesAgo(3))
    const threadId = await threadIdOf(orgId, adminId)
    const [streaming] = await db
      .insert(aiMessages)
      .values({ organizationId: orgId, threadId, role: "assistant", content: "", status: "streaming", requestId: deadAi })
      .returning({ id: aiMessages.id })

    const told: unknown[] = []
    const leave = live.subscribe(`user:${adminId}`, (payload) => told.push(payload))
    await endStaleAi()
    leave()

    const requests = await db
      .select({ id: aiRequests.id, status: aiRequests.status })
      .from(aiRequests)
      .where(inArray(aiRequests.id, [liveAi, liveMcp, deadAi, deadMcp]))
    expect(Object.fromEntries(requests.map((row) => [row.id, row.status]))).toEqual({
      [liveAi]: "running",
      [liveMcp]: "running",
      [deadAi]: "failed",
      [deadMcp]: "done",
    })
    const cards = await db
      .select({ id: aiHeld.id, status: aiHeld.status })
      .from(aiHeld)
      .where(inArray(aiHeld.id, [liveCard, deadCard]))
    expect(Object.fromEntries(cards.map((row) => [row.id, row.status]))).toEqual({ [liveCard]: "allowed", [deadCard]: "failed" })
    const [message] = await db.select({ status: aiMessages.status }).from(aiMessages).where(eq(aiMessages.id, streaming.id))
    expect(message.status).toBe("failed")
    expect(told.map((payload) => JSON.parse(payload as string))).toContainEqual(
      expect.objectContaining({ type: "ai-message", message: expect.objectContaining({ id: streaming.id, status: "failed" }) }),
    )
  })

  async function cardAfterRestart() {
    const { orgId, adminId } = await makeWorkspace()
    await db.insert(aiSettings).values({ organizationId: orgId, enabled: true, baseUrl: "http://model.test/v1", model: "test-model" })
    const taskId = await makeTask(orgId, { projectId: await makeProject(orgId, adminId) })
    model.turns = [
      [{ type: "tool_calls", calls: [{ id: "call-1", name: "delete_task", arguments: JSON.stringify({ taskId }) }] }],
      [{ type: "text", text: "I moved the task to the trash." }],
    ]
    const asker = { userId: adminId, organizationId: orgId, isAdmin: true }
    const { requestId } = await askInDm(asker, "Delete my task")

    const held = await vi.waitFor(
      async () => {
        const [row] = await db
          .select({ id: aiHeld.id, resume: aiHeld.resume, status: aiRequests.status })
          .from(aiHeld)
          .innerJoin(aiRequests, eq(aiRequests.id, aiHeld.requestId))
          .where(eq(aiHeld.requestId, requestId))
        expect(row?.resume).toBeTruthy()
        expect(row.status).toBe("done")
        return row
      },
      { timeout: 5000 },
    )
    forgetPausedForTests()
    return { orgId, asker, held, requestId }
  }

  it("answering a card after a restart lets the AI reply", async () => {
    const { orgId, asker, held, requestId } = await cardAfterRestart()
    await answerHeld(asker, held.id, "allow")

    await vi.waitFor(
      async () => {
        const replies = await db
          .select({ content: aiMessages.content })
          .from(aiMessages)
          .where(and(eq(aiMessages.organizationId, orgId), eq(aiMessages.role, "assistant"), ne(aiMessages.requestId, requestId)))
        expect(replies.map((row) => row.content)).toEqual(["I moved the task to the trash."])
      },
      { timeout: 5000 },
    )
    const [after] = await db.select({ resume: aiHeld.resume }).from(aiHeld).where(eq(aiHeld.id, held.id))
    expect(after.resume).toBeNull()
  })

  it("a card answered after a restart with nothing to resume says so in the DM", async () => {
    const { orgId, asker, held, requestId } = await cardAfterRestart()
    await db.update(aiHeld).set({ resume: null }).where(eq(aiHeld.id, held.id))
    await answerHeld(asker, held.id, "allow")

    await vi.waitFor(
      async () => {
        const notes = await db
          .select({ content: aiMessages.content })
          .from(aiMessages)
          .where(and(eq(aiMessages.organizationId, orgId), eq(aiMessages.requestId, requestId)))
        expect(notes.map((row) => row.content)).toContainEqual(expect.stringContaining("I was restarted while this card waited"))
      },
      { timeout: 5000 },
    )
  })
})
