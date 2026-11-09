import { describe, expect, it } from "vitest"
import { daysLeft, eventTrashRights, projectTrashRights, restoreBlock, taskTrashRights } from "./trash"

const ALL = { see: true, restore: true, purge: true }
const NONE = { see: false, restore: false, purge: false }

describe("trash rules", () => {
  it("lets every project member restore a project task and only admins and the deleter purge it", () => {
    const task = { projectId: "p1", assignedTo: "u1", deletedBy: "u2" }
    expect(taskTrashRights(task, { userId: "u3", projectRole: "member" })).toEqual({ see: true, restore: true, purge: false })
    expect(taskTrashRights(task, { userId: "u2", projectRole: "member" })).toEqual(ALL)
    expect(taskTrashRights(task, { userId: "u4", projectRole: "admin" })).toEqual(ALL)
    expect(taskTrashRights(task, { userId: "u5", projectRole: null })).toEqual(NONE)
  })

  it("keeps a personal task to its assignee", () => {
    const task = { projectId: null, assignedTo: "u1", deletedBy: "u1" }
    expect(taskTrashRights(task, { userId: "u1", projectRole: null })).toEqual(ALL)
    expect(taskTrashRights(task, { userId: "u2", projectRole: null })).toEqual(NONE)
  })

  it("lets the organiser and the admin who deleted an event act on it", () => {
    const event = { createdBy: "u1", deletedBy: "admin" }
    expect(eventTrashRights(event, { userId: "u1", isOrgAdmin: false })).toEqual(ALL)
    expect(eventTrashRights(event, { userId: "admin", isOrgAdmin: true })).toEqual(ALL)
    expect(eventTrashRights(event, { userId: "admin", isOrgAdmin: false })).toEqual(NONE)
    expect(eventTrashRights(event, { userId: "u3", isOrgAdmin: true })).toEqual(NONE)
  })

  it("keeps a trashed project to its admins and workspace admins", () => {
    expect(projectTrashRights({ projectRole: "admin", isOrgAdmin: false })).toEqual(ALL)
    expect(projectTrashRights({ projectRole: "member", isOrgAdmin: false })).toEqual(NONE)
    expect(projectTrashRights({ projectRole: null, isOrgAdmin: true })).toEqual(ALL)
  })

  it("refuses a task whose project is in Trash", () => {
    expect(restoreBlock({ name: "Website", deletedAt: "2026-10-29" })).toBe("Restore the project Website first")
    expect(restoreBlock({ name: "Website", deletedAt: null })).toBeNull()
    expect(restoreBlock(null)).toBeNull()
  })

  it("counts the days left", () => {
    const now = new Date("2026-11-01T12:00:00Z")
    expect(daysLeft("2026-10-29 12:00:00", now)).toBe(27)
    expect(daysLeft("2026-10-01 12:00:00", now)).toBe(0)
  })
})
