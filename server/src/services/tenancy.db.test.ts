import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { aiActivity, db, fileFolders, notifications, organizationMembers, organizations, timeEntries, users } from "../db"
import { caller, testApp } from "../test/app"
import { makeFile, makeUser, makeWorkspace } from "../test/factories"
import { AppError, callAs } from "./acting"
import { isMemberOf, membersOf, orgMemberIds, outsiders, resolveOrg, resolveOrgs } from "./tenancy"

const WORD = "Zephyrine"

let app: FastifyInstance
let home: { orgId: string; adminId: string }
let away: { orgId: string; adminId: string }
let homeMember: string
let awayMember: string
const item = {} as {
  project: string
  slug: string
  task: string
  trashed: string
  event: string
  paper: string
  file: string
  chat: string
  folder: string
  notice: string
  entry: string
  activity: string
}

beforeAll(async () => {
  app = await testApp()
  home = await makeWorkspace()
  away = await makeWorkspace()
  homeMember = await makeUser(home.orgId)
  awayMember = await makeUser(away.orgId)

  const owner = caller(app, home.adminId)
  const created = async (method: "POST" | "DELETE", url: string, payload?: object) => {
    const res = await owner(method, url, payload)
    expect(res.statusCode, `${method} ${url} ${res.payload}`).toBeLessThan(300)
    return res.json()
  }
  const project = await created("POST", "/api/projects", { name: `${WORD} launch` })
  item.project = project.id
  item.slug = project.slug
  item.task = (await created("POST", "/api/tasks", { title: `${WORD} task`, project_id: project.id, assigned_to: home.adminId })).id
  item.trashed = (await created("POST", "/api/tasks", { title: `${WORD} old task`, project_id: project.id })).id
  await created("DELETE", `/api/tasks/${item.trashed}`)
  item.event = (
    await created("POST", "/api/calendar", {
      title: `${WORD} all hands`,
      starts_at: "2026-03-10T09:00:00Z",
      ends_at: "2026-03-10T10:00:00Z",
      everyone: true,
    })
  ).id
  item.paper = (await created("POST", "/api/papers", { docType: "paper", name: `${WORD} notes` })).id
  item.file = await makeFile(home.orgId, home.adminId, { fileName: `${WORD}.txt` })
  const chats = await owner("GET", "/api/chats")
  item.chat = /"id":"(?:group-)?([0-9a-f-]{36})"/.exec(chats.payload)![1]
  await created("POST", `/api/group-chats/${item.chat}/messages`, { content: `${WORD} hello` })

  const [folder] = await db
    .insert(fileFolders)
    .values({ name: `${WORD} folder`, organizationId: home.orgId, createdBy: home.adminId })
    .returning({ id: fileFolders.id })
  item.folder = folder.id
  const [notice] = await db
    .insert(notifications)
    .values({ organizationId: home.orgId, userId: home.adminId, kind: "task_assigned", actorId: homeMember, taskId: item.task })
    .returning({ id: notifications.id })
  item.notice = notice.id
  await db
    .update(organizations)
    .set({ timeTracking: true })
    .where(inArray(organizations.id, [home.orgId, away.orgId]))
  const [entry] = await db
    .insert(timeEntries)
    .values({
      organizationId: home.orgId,
      userId: home.adminId,
      projectId: item.project,
      date: new Date().toISOString().slice(0, 10),
      minutes: 30,
      source: "auto",
      needsCheck: true,
    })
    .returning({ id: timeEntries.id })
  item.entry = entry.id
  const [activity] = await db
    .insert(aiActivity)
    .values({
      organizationId: home.orgId,
      userId: home.adminId,
      source: "ai",
      tool: "delete_task",
      targetKind: "task",
      targetId: item.task,
      result: "held",
    })
    .returning({ id: aiActivity.id })
  item.activity = activity.id
})

afterAll(() => app.close())

describe("membership lookups", () => {
  it("resolve each user to their own workspace only", async () => {
    expect(await resolveOrg(homeMember)).toEqual({ organizationId: home.orgId, role: "member" })
    const both = await resolveOrgs([home.adminId, away.adminId])
    expect(both.get(home.adminId)).toEqual({ organizationId: home.orgId, role: "admin" })
    expect(both.get(away.adminId)).toEqual({ organizationId: away.orgId, role: "admin" })
  })

  it("count only members of the workspace asked about", async () => {
    expect(await membersOf(home.orgId, [home.adminId, homeMember, away.adminId, awayMember])).toEqual(new Set([home.adminId, homeMember]))
    expect(await outsiders(home.orgId, [homeMember, awayMember])).toEqual([awayMember])
    expect(await isMemberOf(awayMember, home.orgId)).toBe(false)
    expect(await isMemberOf(homeMember, home.orgId)).toBe(true)
    expect((await orgMemberIds(home.orgId)).sort()).toEqual([home.adminId, homeMember].sort())
  })
})

describe("another workspace's admin", () => {
  const LISTS = [
    ["projects", "/api/projects/all", () => item.project],
    ["my projects", "/api/projects/user", () => item.project],
    ["my tasks", "/api/tasks/user", () => item.task],
    ["the calendar", "/api/calendar/range?start=2026-03-10T00:00:00Z&end=2026-03-11T00:00:00Z", () => item.event],
    ["search", `/api/search?q=${WORD}`, () => item.project],
    ["file search", `/api/files/search?q=${WORD}`, () => item.file],
    ["chats", "/api/chats", () => item.chat],
    ["Trash", "/api/trash", () => item.trashed],
    ["members", "/api/organizations/members", () => homeMember],
    ["my files", "/api/files/browse?section=mine", () => item.folder],
    ["recent files", "/api/files/browse?section=recent", () => item.file],
    ["notifications", "/api/notifications", () => item.notice],
    ["time tracking", "/api/time/state", () => item.entry],
    ["the AI activity", "/api/ai/activity?scope=workspace", () => item.activity],
  ] as const

  it.each(LISTS)("finds nothing of the home workspace in %s", async (_name, url, id) => {
    const [ours, theirs] = await Promise.all([caller(app, home.adminId)("GET", url), caller(app, away.adminId)("GET", url)])
    expect([ours.statusCode, ours.payload.includes(id())]).toEqual([200, true])
    expect(theirs.statusCode).toBeLessThan(500)
    expect(theirs.payload.includes(id())).toBe(false)
    expect(theirs.payload.includes(WORD)).toBe(false)
  })

  it("finds no home member when searching users", async () => {
    const [{ lastName }] = await db.select({ lastName: users.lastName }).from(users).where(eq(users.id, homeMember))
    const url = `/api/users/search?q=${lastName}`
    const [ours, theirs] = await Promise.all([caller(app, home.adminId)("GET", url), caller(app, away.adminId)("GET", url)])
    expect(ours.payload.includes(homeMember)).toBe(true)
    expect(theirs.payload.includes(homeMember)).toBe(false)
  })

  const BY_ID = [
    ["GET", "/api/projects/:project"],
    ["GET", "/api/projects/slug/:slug"],
    ["GET", "/api/tasks/project/:project"],
    ["GET", "/api/tasks/:task"],
    ["GET", "/api/calendar/:event"],
    ["GET", "/api/papers/:paper"],
    ["GET", "/api/files/:file"],
    ["GET", "/api/users/:member"],
    ["PUT", "/api/tasks/:task", { title: "Taken over" }],
    ["DELETE", "/api/calendar/:event"],
    ["DELETE", "/api/projects/:project"],
  ] as const
  const fill = (path: string) =>
    path.replace(/:(\w+)/, (_, name: string) => (name === "member" ? homeMember : item[name as keyof typeof item]))

  it.each(BY_ID)("gets 404 on %s %s", async (method, path, payload?: object) => {
    const res = await caller(app, away.adminId)(method, fill(path), payload)
    expect(res.statusCode, res.payload).toBe(404)
  })

  it("gets the same answer for the home chat as for one that does not exist", async () => {
    const theirs = caller(app, away.adminId)
    const [ours, missing] = await Promise.all([
      theirs("GET", `/api/group-chats/${item.chat}/messages`),
      theirs("GET", `/api/group-chats/${randomUUID()}/messages`),
    ])
    expect([ours.statusCode, ours.json()]).toEqual([missing.statusCode, missing.json()])
    expect(ours.statusCode).toBeGreaterThanOrEqual(400)
  })

  it("cannot post a task into the home project", async () => {
    const res = await caller(app, away.adminId)("POST", "/api/tasks", { title: "Planted", project_id: item.project })
    expect(res.statusCode).toBe(404)
  })

  it("leaves the home rows as they were after trying to change them", async () => {
    const theirs = caller(app, away.adminId)
    await theirs("PUT", `/api/tasks/${item.task}`, { title: "Taken over" })
    await theirs("DELETE", `/api/calendar/${item.event}`)
    await theirs("DELETE", `/api/projects/${item.project}`)
    const ours = caller(app, home.adminId)
    for (const url of [`/api/projects/${item.project}`, `/api/tasks/${item.task}`, `/api/calendar/${item.event}`]) {
      const res = await ours("GET", url)
      expect(res.statusCode, url).toBe(200)
      expect(res.payload.includes("Taken over")).toBe(false)
    }
  })
})

describe("a removed member", () => {
  it("is refused at once, by their own session and when the AI acts for them", async () => {
    const leaver = await makeUser(home.orgId)
    const asLeaver = caller(app, leaver)
    const viaAi = () => callAs({ id: leaver, organizationId: home.orgId }, { kind: "ai" }, { method: "GET", url: "/api/projects/all" })
    expect((await asLeaver("GET", "/api/projects/all")).statusCode).toBe(200)
    await expect(viaAi()).resolves.toBeDefined()

    const [membership] = await db.select().from(organizationMembers).where(eq(organizationMembers.userId, leaver))
    const removed = await caller(app, home.adminId)("DELETE", `/api/organizations/members/${membership.id}`)
    expect(removed.statusCode, removed.payload).toBe(200)

    expect(await db.select().from(organizationMembers).where(eq(organizationMembers.userId, leaver))).toEqual([])
    expect((await asLeaver("GET", "/api/projects/all")).statusCode).toBe(401)
    await expect(viaAi()).rejects.toMatchObject({ status: 401 } satisfies Partial<AppError>)
  })

  it("is refused by the AI even while their session would still verify", async () => {
    const leaver = await makeUser(home.orgId)
    await db.delete(organizationMembers).where(eq(organizationMembers.userId, leaver))
    await expect(
      callAs({ id: leaver, organizationId: home.orgId }, { kind: "ai" }, { method: "GET", url: "/api/projects/all" }),
    ).rejects.toMatchObject({ status: 401 })
  })
})
