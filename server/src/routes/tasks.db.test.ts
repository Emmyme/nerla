import { and, eq } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { db, projectMembers, projects, tasks } from "../db"
import { live } from "../live/live"
import * as projectAccess from "../services/projectAccess"
import { caller, testApp } from "../test/app"
import { makeProject, makeTask, makeUser, makeWorkspace } from "../test/factories"

vi.mock("../services/projectAccess", async (original) => {
  const actual = await original<typeof import("../services/projectAccess")>()
  return { ...actual, projectReadAccess: vi.fn(actual.projectReadAccess) }
})

let app: FastifyInstance

beforeAll(async () => {
  app = await testApp()
})

afterAll(() => app.close())

describe("a new task", () => {
  it("is refused when its project went to the trash after the access check", async () => {
    const { orgId, adminId } = await makeWorkspace()
    const projectId = await makeProject(orgId, adminId)
    const check = vi.mocked(projectAccess.projectReadAccess)
    const real = check.getMockImplementation()!
    check.mockImplementationOnce(async (...args) => {
      const access = await real(...args)
      await db.update(projects).set({ deletedAt: new Date().toISOString() }).where(eq(projects.id, projectId))
      return access
    })
    const res = await caller(app, adminId)("POST", "/api/tasks", { title: "Lost", project_id: projectId })
    expect([res.statusCode, res.json()]).toEqual([404, { error: "Project not found" }])
    expect(await db.select().from(tasks).where(eq(tasks.projectId, projectId))).toEqual([])
  })
})

describe("a task change", () => {
  it("reaches the project's members and nobody else", async () => {
    const { orgId, adminId } = await makeWorkspace()
    const memberId = await makeUser(orgId)
    const projectId = await makeProject(orgId, adminId)
    const outsiderId = await makeUser(orgId)
    await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, outsiderId)))
    const taskId = await makeTask(orgId, { projectId, assignedTo: adminId })
    const heard = new Map<string, unknown[]>()
    const leave = [adminId, memberId, outsiderId, (await makeWorkspace()).adminId].map((id) =>
      live.subscribe(`user:${id}`, (message) => heard.set(id, [...(heard.get(id) ?? []), JSON.parse(message as string)])),
    )
    const res = await caller(app, adminId)("PUT", `/api/tasks/${taskId}`, { status: "done" })
    leave.forEach((off) => off())
    expect(res.statusCode).toBe(200)
    const event = [{ type: "tasks-changed", projectId, organizationId: orgId }]
    expect([...heard]).toEqual([
      [adminId, event],
      [memberId, event],
    ])
  })
})
