import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { db, organizationMembers, projectMembers, projectPins, projects, tasks } from "../db"
import { makeProject, makeTask, makeUser, makeWorkspace } from "../test/factories"
import {
  ADMIN_VIEWER,
  leaveProject,
  memberProjectIds,
  projectAccess,
  projectReadAccess,
  projectReadAccessBySlug,
  readableProjectIds,
} from "./projectAccess"

let orgId: string
let adminId: string
let ownerId: string
let memberId: string
let away: { orgId: string; adminId: string }
let shared: string
let closed: string
let trashed: string
let foreign: string

/** The ids among the projects made in `beforeAll`, since other tests add projects of their own */
const ids = async (query: { id: string }[] | PromiseLike<{ id: string }[]>) =>
  (await query)
    .map((row) => row.id)
    .filter((id) => [shared, closed, trashed, foreign].includes(id))
    .sort()
const roleOf = async (projectId: string, userId: string) =>
  (
    await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
  )[0]?.role ?? null

beforeAll(async () => {
  ;({ orgId, adminId } = await makeWorkspace())
  ownerId = await makeUser(orgId)
  memberId = await makeUser(orgId)
  away = await makeWorkspace()
  // The workspace admin joins only the shared project
  shared = await makeProject(orgId, ownerId)
  closed = await makeProject(orgId, ownerId, { private: true })
  await db.insert(projectMembers).values({ projectId: closed, userId: memberId })
  trashed = await makeProject(orgId, ownerId)
  await db.update(projects).set({ deletedAt: new Date().toISOString() }).where(eq(projects.id, trashed))
  foreign = await makeProject(away.orgId, away.adminId)
})

describe("project access", () => {
  it("gives a member their role, for reads and writes", async () => {
    expect((await projectAccess(memberId, orgId, closed))?.role).toBe("member")
    expect((await projectAccess(ownerId, orgId, closed))?.role).toBe("admin")
    expect((await projectReadAccess(memberId, orgId, closed))?.role).toBe("member")
  })

  it("lets a workspace admin outside the project read it and never write", async () => {
    expect(await projectAccess(adminId, orgId, closed)).toBeNull()
    expect((await projectReadAccess(adminId, orgId, closed))?.role).toBe(ADMIN_VIEWER)
    const [{ slug }] = await db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, closed))
    expect((await projectReadAccessBySlug(adminId, orgId, slug))?.role).toBe(ADMIN_VIEWER)
  })

  it("never opens a project to a user outside it who is no admin", async () => {
    const outsider = await makeUser(orgId)
    expect(await projectAccess(outsider, orgId, closed)).toBeNull()
    expect(await projectReadAccess(outsider, orgId, closed)).toBeNull()
  })

  it("never opens a project in Trash, not even to its own admin", async () => {
    expect(await projectAccess(ownerId, orgId, trashed)).toBeNull()
    expect(await projectReadAccess(adminId, orgId, trashed)).toBeNull()
  })

  it("never opens another workspace's project, whoever asks and from where", async () => {
    expect(await projectReadAccess(adminId, orgId, foreign)).toBeNull()
    expect(await projectReadAccess(away.adminId, orgId, shared)).toBeNull()
    expect(await projectReadAccess(adminId, away.orgId, foreign)).toBeNull()
  })

  it("lists the projects each user may read and is a member of", async () => {
    expect(await ids(readableProjectIds(adminId, orgId))).toEqual([shared, closed].sort())
    expect(await ids(readableProjectIds(memberId, orgId))).toEqual([shared, closed].sort())
    expect(await ids(memberProjectIds(adminId, orgId))).toEqual([shared])
    expect(await ids(memberProjectIds(ownerId, orgId))).toEqual([shared, closed].sort())
    expect((await readableProjectIds(away.adminId, orgId)).length).toBe(0)
  })
})

describe("leaving a project", () => {
  it("takes the leaver's pins and assignments with them, and nobody else's", async () => {
    const project = await makeProject(orgId, ownerId)
    const elsewhere = await makeProject(orgId, ownerId)
    const theirs = await makeTask(orgId, { projectId: project, assignedTo: memberId })
    const other = await makeTask(orgId, { projectId: elsewhere, assignedTo: memberId })
    const owners = await makeTask(orgId, { projectId: project, assignedTo: ownerId })
    await db.insert(projectPins).values([
      { userId: memberId, projectId: project, organizationId: orgId },
      { userId: ownerId, projectId: project, organizationId: orgId },
    ])

    await db.transaction((tx) => leaveProject(tx, project, [memberId]))

    expect(await roleOf(project, memberId)).toBeNull()
    expect(await roleOf(project, ownerId)).toBe("admin")
    const pins = await db.select({ userId: projectPins.userId }).from(projectPins).where(eq(projectPins.projectId, project))
    expect(pins.map((pin) => pin.userId)).toEqual([ownerId])
    const assigned = await db.select({ id: tasks.id, assignedTo: tasks.assignedTo }).from(tasks)
    const byId = new Map(assigned.map((row) => [row.id, row.assignedTo]))
    expect([byId.get(theirs), byId.get(other), byId.get(owners)]).toEqual([null, memberId, ownerId])
  })

  it("promotes the longest-standing member when the last admin leaves, never someone who left the workspace", async () => {
    const stale = await makeUser(orgId)
    const next = await makeUser(orgId)
    const project = await makeProject(orgId, ownerId, { private: true })
    await db.insert(projectMembers).values([
      { projectId: project, userId: stale, createdAt: "2020-01-01 00:00:00" },
      { projectId: project, userId: next, createdAt: "2021-01-01 00:00:00" },
    ])
    await db.delete(organizationMembers).where(eq(organizationMembers.userId, stale))

    await db.transaction((tx) => leaveProject(tx, project, [ownerId]))

    expect([await roleOf(project, next), await roleOf(project, stale), await roleOf(project, ownerId)]).toEqual(["admin", "member", null])
  })
})
