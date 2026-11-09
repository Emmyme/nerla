import { eq, inArray } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  calendarEvents,
  db,
  fileAttachments,
  fileLinks,
  groupChatMembers,
  groupChats,
  meetingParticipants,
  projects,
  tasks,
  timeEntries,
} from "../db"
import { signedIn, testApp } from "../test/app"
import { makeEvent, makeFile, makeProject, makeTask, makeUser, makeWorkspace, trashedDaysAgo } from "../test/factories"
import { purgeProject, restoreProject, trashProject } from "./projectTrash"
import { restoreTask, trashTask } from "./taskTrash"
import { purgeDueEvents, purgeDueProjects, purgeDueTasks } from "./trashCleanup"
import { DAY_MS } from "../utils/eventTime"

let app: FastifyInstance
let orgId: string
let adminId: string
let memberId: string

const admin = () => ({ userId: adminId, organizationId: orgId, isOrgAdmin: true })
const exists = async (table: typeof projects | typeof tasks | typeof fileAttachments | typeof calendarEvents, id: string) =>
  (await db.select({ id: table.id }).from(table).where(eq(table.id, id))).length === 1

beforeAll(async () => {
  app = await testApp()
  ;({ orgId, adminId } = await makeWorkspace())
  memberId = await makeUser(orgId)
})

afterAll(() => app.close())

describe("the 30-day purge", () => {
  it("deletes a project past 30 days with its tasks and stored files, and keeps one at 29 days", async () => {
    const old = await makeProject(orgId, adminId)
    const oldTask = await makeTask(orgId, { projectId: old })
    const oldFile = await makeFile(orgId, adminId, { projectId: old })
    const recent = await makeProject(orgId, adminId)
    const recentTask = await makeTask(orgId, { projectId: recent })
    const recentFile = await makeFile(orgId, adminId, { projectId: recent })
    for (const id of [old, recent]) expect(await trashProject(id, admin(), null)).toEqual({ id })
    await trashedDaysAgo("projects", old, 31)
    await trashedDaysAgo("projects", recent, 29)

    await purgeDueProjects(new Date())

    expect(await exists(projects, old)).toBe(false)
    expect(await exists(tasks, oldTask)).toBe(false)
    expect(await exists(fileAttachments, oldFile)).toBe(false)
    expect(await exists(projects, recent)).toBe(true)
    expect(await exists(tasks, recentTask)).toBe(true)
    expect(await exists(fileAttachments, recentFile)).toBe(true)
  })

  it("never purges a project restored after the purge found it", async () => {
    const project = await makeProject(orgId, adminId)
    await trashProject(project, admin(), null)
    await trashedDaysAgo("projects", project, 31)
    await restoreProject(project, admin())

    const cutoff = new Date(Date.now() - 30 * DAY_MS).toISOString()
    expect(await purgeProject(project, orgId, { trashedBefore: cutoff })).toBe(false)
    await purgeDueProjects(new Date())
    expect(await exists(projects, project)).toBe(true)
  })

  it("deletes a task trashed on its own past 30 days, and leaves one that went with its project to the project", async () => {
    const project = await makeProject(orgId, adminId)
    const own = await makeTask(orgId, { projectId: project })
    const recent = await makeTask(orgId, { projectId: project })
    const personal = await makeTask(orgId, { assignedTo: memberId })
    await trashTask(own, { userId: adminId, organizationId: orgId }, null)
    await trashTask(recent, { userId: adminId, organizationId: orgId }, null)
    await trashTask(personal, { userId: memberId, organizationId: orgId }, null)
    await trashedDaysAgo("tasks", own, 31)
    await trashedDaysAgo("tasks", recent, 29)
    await trashedDaysAgo("tasks", personal, 31)

    const withProject = await makeProject(orgId, adminId)
    const carried = await makeTask(orgId, { projectId: withProject })
    await trashProject(withProject, admin(), null)
    await trashedDaysAgo("projects", withProject, 31)

    await purgeDueTasks(new Date())

    expect(await exists(tasks, own)).toBe(false)
    expect(await exists(tasks, personal)).toBe(false)
    expect(await exists(tasks, recent)).toBe(true)
    expect(await exists(tasks, carried)).toBe(true)
  })

  it("deletes an event past 30 days with its occurrences and its room, and keeps one at 29 days", async () => {
    const auth = await signedIn(app, adminId)
    const series = await makeEvent(orgId, adminId, {
      startsAt: "2026-03-02T09:00:00Z",
      endsAt: "2026-03-02T10:00:00Z",
      recurrenceRule: "FREQ=WEEKLY;COUNT=5",
      videoCall: true,
    })
    const moved = await makeEvent(orgId, adminId, {
      startsAt: "2026-03-09T11:00:00Z",
      endsAt: "2026-03-09T12:00:00Z",
      seriesId: series,
      originalStart: "2026-03-09T09:00:00Z",
    })
    const recent = await makeEvent(orgId, adminId, { startsAt: "2026-03-03T09:00:00Z", endsAt: "2026-03-03T10:00:00Z" })
    await db.insert(meetingParticipants).values({ roomName: `meeting-${series}`, userId: memberId, organizationId: orgId })
    for (const id of [series, recent]) {
      expect((await app.inject({ method: "DELETE", url: `/api/calendar/${id}?scope=all`, headers: auth })).statusCode).toBe(200)
    }
    await trashedDaysAgo("calendarEvents", series, 31)
    await trashedDaysAgo("calendarEvents", recent, 29)

    await purgeDueEvents(new Date())

    expect(await exists(calendarEvents, series)).toBe(false)
    expect(await exists(calendarEvents, moved)).toBe(false)
    expect(
      await db
        .select()
        .from(meetingParticipants)
        .where(eq(meetingParticipants.roomName, `meeting-${series}`)),
    ).toEqual([])
    expect(await exists(calendarEvents, recent)).toBe(true)
  })
})

describe("restoring from Trash", () => {
  it("brings a project back with its tasks and files, and leaves what was trashed on its own before in Trash", async () => {
    const project = await makeProject(orgId, adminId)
    const task = await makeTask(orgId, { projectId: project })
    const before = await makeTask(orgId, { projectId: project })
    const file = await makeFile(orgId, adminId, { projectId: project })
    await trashTask(before, { userId: adminId, organizationId: orgId }, null)
    await trashProject(project, admin(), null)

    expect(await restoreProject(project, admin())).toMatchObject({ id: project })

    const rows = await db
      .select({ id: tasks.id, deletedAt: tasks.deletedAt })
      .from(tasks)
      .where(inArray(tasks.id, [task, before]))
    expect(Object.fromEntries(rows.map((row) => [row.id, row.deletedAt !== null]))).toEqual({ [task]: false, [before]: true })
    const [kept] = await db.select({ deletedAt: fileAttachments.deletedAt }).from(fileAttachments).where(eq(fileAttachments.id, file))
    expect(kept.deletedAt).toBeNull()
    const [back] = await db.select({ deletedAt: projects.deletedAt }).from(projects).where(eq(projects.id, project))
    expect(back.deletedAt).toBeNull()
  })
})

describe("hand-written queries skip Trash", () => {
  it("hides a project's chat while the project is in Trash", async () => {
    const auth = await signedIn(app, adminId)
    const project = await makeProject(orgId, adminId)
    const [chat] = await db
      .insert(groupChats)
      .values({ name: "Project chat", createdBy: adminId, projectId: project, organizationId: orgId })
      .returning({ id: groupChats.id })
    await db.insert(groupChatMembers).values({ groupChatId: chat.id, userId: adminId, role: "admin" })
    const listed = async () => (await app.inject({ method: "GET", url: "/api/chats", headers: auth })).payload.includes(chat.id)

    const shown = await listed()
    await trashProject(project, admin(), null)
    const hidden = await listed()
    await restoreProject(project, admin())

    expect([shown, hidden, await listed()]).toEqual([true, false, true])
  })

  it("closes a file posted on a task while the task is in Trash, when opened and in search", async () => {
    const project = await makeProject(orgId, adminId)
    const task = await makeTask(orgId, { projectId: project })
    const file = await makeFile(orgId, adminId, { fileName: "Larkspur.txt" })
    await db.insert(fileLinks).values({ fileId: file, taskId: task, createdBy: adminId, organizationId: orgId })
    const auth = await signedIn(app, memberId)
    const reach = async () => [
      (await app.inject({ method: "GET", url: `/api/files/${file}`, headers: auth })).statusCode,
      (await app.inject({ method: "GET", url: "/api/files/search?q=Larkspur", headers: auth })).payload.includes(file),
    ]

    const before = await reach()
    await trashTask(task, { userId: adminId, organizationId: orgId }, null)
    const during = await reach()
    await restoreTask(task, { userId: adminId, organizationId: orgId }, null)

    expect([before, during, await reach()]).toEqual([
      [200, true],
      [404, false],
      [200, true],
    ])
  })

  it("finds no occurrence of a series in Trash, and finds it again once the series is back", async () => {
    const auth = await signedIn(app, adminId)
    const series = await makeEvent(orgId, adminId, {
      title: "Quillfeather sync",
      startsAt: "2026-03-02T09:00:00Z",
      endsAt: "2026-03-02T10:00:00Z",
      recurrenceRule: "FREQ=WEEKLY;COUNT=5",
    })
    const moved = await makeEvent(orgId, adminId, {
      title: "Quillfeather sync moved",
      startsAt: "2026-03-09T11:00:00Z",
      endsAt: "2026-03-09T12:00:00Z",
      seriesId: series,
      originalStart: "2026-03-09T09:00:00Z",
    })
    const found = async () => {
      const payload = (await app.inject({ method: "GET", url: "/api/search?q=Quillfeather", headers: auth })).payload
      return payload.includes(series) || payload.includes(moved)
    }
    // Only the master goes to Trash, so the override's own row stays live and only the master check hides it
    const masterTrash = (deletedAt: string | null) =>
      db
        .update(calendarEvents)
        .set({ deletedAt, trashRoot: deletedAt ? series : null })
        .where(eq(calendarEvents.id, series))

    const before = await found()
    await masterTrash(new Date().toISOString())
    const during = await found()
    await masterTrash(null)

    expect([before, during, await found()]).toEqual([true, false, true])
  })
})

describe("locked time when its place is deleted for good", () => {
  const LOCK = "2026-06-30"
  const entry = (projectId: string | null, taskId: string | null, date: string) => ({
    organizationId: orgId,
    userId: memberId,
    projectId,
    taskId,
    date,
    minutes: 60,
    source: "manual",
  })

  it("keeps a deleted project's locked time, detached with its names, and drops the rest", async () => {
    const project = await makeProject(orgId, adminId)
    const task = await makeTask(orgId, { projectId: project, title: "Write the brief" })
    await db.update(projects).set({ timeLockedUntil: LOCK, name: "Website" }).where(eq(projects.id, project))
    const [locked, open] = await db
      .insert(timeEntries)
      .values([entry(project, task, "2026-06-15"), entry(project, task, "2026-07-15")])
      .returning({ id: timeEntries.id })
    await trashProject(project, admin(), null)
    expect(await purgeProject(project, orgId, {})).toBe(true)

    const rows = await db
      .select()
      .from(timeEntries)
      .where(inArray(timeEntries.id, [locked.id, open.id]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: locked.id, projectId: null, taskId: null, projectName: "Website", taskLabel: "Write the brief" })
    expect(rows[0].detachedAt).not.toBeNull()
  })

  it("keeps a deleted task's locked time on its project, with the task's name", async () => {
    const project = await makeProject(orgId, adminId)
    const task = await makeTask(orgId, { projectId: project, title: "Fix the header" })
    await db.update(projects).set({ timeLockedUntil: LOCK }).where(eq(projects.id, project))
    const [locked, open] = await db
      .insert(timeEntries)
      .values([entry(project, task, "2026-06-15"), entry(project, task, "2026-07-15")])
      .returning({ id: timeEntries.id })
    await trashTask(task, { userId: adminId, organizationId: orgId }, null)
    await trashedDaysAgo("tasks", task, 31)
    await purgeDueTasks(new Date())

    const rows = await db
      .select()
      .from(timeEntries)
      .where(inArray(timeEntries.id, [locked.id, open.id]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: locked.id, projectId: project, taskId: null, taskLabel: "Fix the header" })
  })
})
