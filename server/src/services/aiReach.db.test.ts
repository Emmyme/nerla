import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { db, groupChatMembers, groupChats, tasks } from "../db"
import { makeEvent, makeFile, makeProject, makeTask, makeUser, makeWorkspace } from "../test/factories"
import type { ItemRef } from "../utils/aiTypes"
import { canRead, type ReachViewer } from "./aiReach"
import { saveSharing } from "./calendarQueries"

let orgId: string
let admin: ReachViewer
let member: ReachViewer
let outsider: ReachViewer
let stranger: ReachViewer

const asked = (viewers: ReachViewer[], ref: ItemRef) => Promise.all(viewers.map((viewer) => canRead(viewer, ref)))

beforeAll(async () => {
  const home = await makeWorkspace()
  orgId = home.orgId
  admin = { userId: home.adminId, organizationId: orgId, isOrgAdmin: true }
  member = { userId: await makeUser(orgId), organizationId: orgId, isOrgAdmin: false }
  outsider = { userId: await makeUser(orgId), organizationId: orgId, isOrgAdmin: false }
  const away = await makeWorkspace()
  stranger = { userId: away.adminId, organizationId: away.orgId, isOrgAdmin: true }
})

describe("what the AI may read for the asker", () => {
  it("a project's task: its members and workspace admins, never once it is in Trash", async () => {
    const project = await makeProject(orgId, member.userId, { private: true })
    const task = await makeTask(orgId, { projectId: project })
    expect(await asked([member, admin, outsider, stranger], { kind: "task", id: task })).toEqual([true, true, false, false])
    await db.update(tasks).set({ deletedAt: new Date().toISOString() }).where(eq(tasks.id, task))
    expect(await asked([member, admin], { kind: "task", id: task })).toEqual([false, false])
  })

  it("an event: only those who see it in full", async () => {
    await saveSharing(member.userId, orgId, { default_level: "busy", grants: [] })
    const event = await makeEvent(orgId, member.userId, {
      startsAt: "2026-03-10T09:00:00Z",
      endsAt: "2026-03-10T10:00:00Z",
      guests: [outsider.userId],
    })
    expect(await asked([member, outsider, admin, stranger], { kind: "event", id: event })).toEqual([true, true, false, false])
  })

  it("a file: its owner, never another member or workspace", async () => {
    const file = await makeFile(orgId, member.userId)
    expect(await asked([member, outsider, stranger], { kind: "file", id: file })).toEqual([true, false, false])
  })

  it("a group chat: its members only", async () => {
    const [chat] = await db
      .insert(groupChats)
      .values({ name: "Team", createdBy: member.userId, organizationId: orgId })
      .returning({ id: groupChats.id })
    await db.insert(groupChatMembers).values({ groupChatId: chat.id, userId: member.userId, role: "admin" })
    expect(await asked([member, admin, stranger], { kind: "chat", id: chat.id })).toEqual([true, false, false])
  })

  it("a person: members of the asker's own workspace", async () => {
    expect(await asked([admin, stranger], { kind: "person", id: member.userId })).toEqual([true, false])
  })
})
