import { describe, expect, it } from "vitest"
import { canAccessTask, moveRefusal, taskAccessLevel, type TaskMove } from "./taskAccess"

const live = null as string | null

describe("canAccessTask", () => {
  const projectTask = (memberIds: string[]) => ({
    projectId: "p1",
    assignedTo: "someone",
    organizationId: "org-a",
    deletedAt: live,
    project: {
      organizationId: "org-a",
      deletedAt: live,
      members: memberIds.map((userId) => ({ userId })),
    },
  })

  it.each([
    ["allows a project member", ["me"], true],
    ["refuses someone in the organization who is not a member", ["someone"], false],
    ["finds the caller among several members", ["someone", "me"], true],
  ])("%s", (_name, memberIds, allowed) => {
    expect(canAccessTask(projectTask(memberIds), "me", "org-a")).toBe(allowed)
  })

  it("refuses a member when the organization does not match", () => {
    expect(canAccessTask(projectTask(["me"]), "me", "org-b")).toBe(false)
    const elsewhere = {
      ...projectTask(["me"]),
      project: { organizationId: "org-b", deletedAt: live, members: [{ userId: "me" }] },
    }
    expect(canAccessTask(elsewhere, "me", "org-a")).toBe(false)
    expect(taskAccessLevel(elsewhere, "me", "org-a", true)).toBeNull()
  })

  it("refuses a project task whose project or members did not load", () => {
    const noProject = { ...projectTask(["me"]), project: null }
    const noMembers = { ...projectTask(["me"]), project: { organizationId: "org-a", deletedAt: live } }
    expect(canAccessTask(noProject, "me", "org-a")).toBe(false)
    expect(canAccessTask(noMembers, "me", "org-a")).toBe(false)
    expect(taskAccessLevel(noProject, "me", "org-a", true)).toBeNull()
  })

  it("opens a personal task to its assignee only", () => {
    const personal = { projectId: null, assignedTo: "me", organizationId: "org-a", deletedAt: live, project: null }
    expect(canAccessTask(personal, "me", "org-a")).toBe(true)
    expect(canAccessTask(personal, "someone", "org-a")).toBe(false)
  })

  it("refuses a personal task of another workspace even to its assignee", () => {
    const personal = { projectId: null, assignedTo: "me", organizationId: "org-b", deletedAt: live, project: null }
    expect(canAccessTask(personal, "me", "org-a")).toBe(false)
  })
})

describe("taskAccessLevel", () => {
  const projectTask = (memberIds: string[], organizationId = "org-a") => ({
    projectId: "p1",
    assignedTo: "someone",
    organizationId,
    deletedAt: live,
    project: { organizationId, deletedAt: live, members: memberIds.map((userId) => ({ userId })) },
  })

  it("lets members change the task and a workspace admin outside the project only read it", () => {
    expect(taskAccessLevel(projectTask(["me"]), "me", "org-a", false)).toBe("member")
    expect(taskAccessLevel(projectTask(["me"]), "me", "org-a", true)).toBe("member")
    expect(taskAccessLevel(projectTask(["someone"]), "me", "org-a", true)).toBe("admin-viewer")
    expect(taskAccessLevel(projectTask(["someone"]), "me", "org-a", false)).toBeNull()
  })

  it("gives an admin nothing in another workspace or on another user's personal task", () => {
    expect(taskAccessLevel(projectTask(["someone"], "org-b"), "me", "org-a", true)).toBeNull()
    expect(taskAccessLevel({ ...projectTask(["someone"]), organizationId: "org-b" }, "me", "org-a", true)).toBeNull()
    const personal = { projectId: null, assignedTo: "someone", organizationId: "org-a", deletedAt: live, project: null }
    expect(taskAccessLevel(personal, "me", "org-a", true)).toBeNull()
  })

  it("gives nobody a task in Trash, or one whose project is in Trash", () => {
    const deletedAt = "2026-10-30 10:00:00"
    const member = projectTask(["me"])
    const outside = projectTask(["someone"])
    const trashed = [
      { ...member, deletedAt },
      { ...member, project: { ...member.project, deletedAt } },
      { ...outside, deletedAt },
      { ...outside, project: { ...outside.project, deletedAt } },
      { projectId: null, assignedTo: "me", organizationId: "org-a", deletedAt, project: null },
    ]
    for (const task of trashed) {
      expect(canAccessTask(task, "me", "org-a")).toBe(false)
      expect(taskAccessLevel(task, "me", "org-a", true)).toBeNull()
    }
  })
})

const projectToProject: TaskMove = {
  fromPersonal: false,
  toPersonal: false,
  callerInSource: true,
  callerInTarget: true,
  isAssignee: false,
  hasOthersContent: true,
}

const toPersonal: TaskMove = {
  ...projectToProject,
  toPersonal: true,
  callerInTarget: false,
  isAssignee: true,
  hasOthersContent: false,
}

describe("moveRefusal", () => {
  it("allows a member of both projects to move a task", () => {
    expect(moveRefusal(projectToProject)).toBeNull()
  })

  it("refuses a caller outside the source or the target project", () => {
    const forbidden = {
      code: 403,
      error: "You need to be a member of both projects to move this task",
    }
    expect(moveRefusal({ ...projectToProject, callerInSource: false })).toEqual(forbidden)
    expect(moveRefusal({ ...projectToProject, callerInTarget: false })).toEqual(forbidden)
    expect(moveRefusal({ ...toPersonal, callerInSource: false })).toEqual(forbidden)
  })

  it("only checks the target when a personal task joins a project", () => {
    expect(
      moveRefusal({
        ...projectToProject,
        fromPersonal: true,
        callerInSource: false,
      }),
    ).toBeNull()
  })

  it("lets the assignee make a task personal with only their content", () => {
    expect(moveRefusal(toPersonal)).toBeNull()
    expect(moveRefusal({ ...toPersonal, isAssignee: false })).toEqual({
      code: 400,
      error: "Only your own tasks can become personal",
    })
    expect(moveRefusal({ ...toPersonal, hasOthersContent: true })).toEqual({
      code: 400,
      error: "This task has comments or files from other people, so it can't become personal",
    })
  })
})
