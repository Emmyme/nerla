import { describe, expect, it } from "vitest"
import { groupKey, recipientsFor, shouldGroup, type Candidate, type NotificationEvent } from "./notificationRules"

const actorId = "actor"
const comment: NotificationEvent = { type: "comment", actorId, taskId: "t1", commentId: "c1", mentions: [], edited: false }
const changed: NotificationEvent = {
  type: "task_changed",
  actorId,
  taskId: "t1",
  assigned: false,
  statusOrDue: true,
  completed: false,
  changes: 1,
}

const candidate = (overrides: Partial<Candidate>): Candidate => ({
  userId: "u1",
  isActor: false,
  relations: ["project_member"],
  canSee: true,
  mentioned: false,
  prefs: {},
  ...overrides,
})

describe("recipientsFor", () => {
  it("never notifies the actor", () => {
    const self = candidate({ userId: actorId, isActor: true, relations: ["assignee", "project_member"] })
    expect(recipientsFor(comment, [self])).toEqual([])
  })

  it("gives nothing to a user who can't see the place", () => {
    expect(recipientsFor(comment, [candidate({ relations: ["assignee"], canSee: false, mentioned: true })])).toEqual([])
  })

  it("defaults to involves you on and everything off", () => {
    const assignee = candidate({ userId: "a", relations: ["assignee", "project_member"] })
    const member = candidate({ userId: "m" })
    expect(recipientsFor(comment, [assignee, member])).toEqual([{ userId: "a", kind: "comment_on_my_task", bell: true, desktop: true }])
  })

  it("gives a mentioned assignee only the mention", () => {
    const assignee = candidate({ relations: ["assignee", "creator", "project_member"], mentioned: true })
    expect(recipientsFor(comment, [assignee])).toEqual([{ userId: "u1", kind: "mentioned", bell: true, desktop: true }])
  })

  it("fills the bell from the next kind when the winning kind has only desktop on", () => {
    const assignee = candidate({
      relations: ["assignee", "project_member"],
      mentioned: true,
      prefs: { mentioned: { bell: false, desktop: true }, comment_on_my_task: { bell: true, desktop: false } },
    })
    expect(recipientsFor(comment, [assignee])).toEqual([{ userId: "u1", kind: "comment_on_my_task", bell: true, desktop: true }])
  })

  it("gives a member who turned on project changes that kind", () => {
    const member = candidate({ prefs: { project_task_changed: { bell: true, desktop: false } } })
    expect(recipientsFor(changed, [member])).toEqual([{ userId: "u1", kind: "project_task_changed", bell: true, desktop: false }])
  })

  it("gives an admin reader outside the project no project kinds", () => {
    const everythingOn = {
      project_task_changed: { bell: true, desktop: true },
      project_comment: { bell: true, desktop: true },
    }
    const adminReader = candidate({ relations: [], prefs: everythingOn })
    expect(recipientsFor(changed, [adminReader])).toEqual([])
    expect(recipientsFor(comment, [adminReader])).toEqual([])
  })
})

describe("shouldGroup", () => {
  const now = new Date("2026-10-27T12:00:00Z")
  const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000).toISOString()
  const key = groupKey(changed, "project_task_changed")

  it.each([
    ["groups the same actor, task and change kind at 9 minutes", 9, true],
    ["does not group at 11 minutes", 11, false],
  ])("%s", (_name, minutes, grouped) => {
    expect(shouldGroup({ groupKey: key, updatedAt: minutesAgo(minutes) }, { groupKey: key }, now)).toBe(grouped)
  })

  it("never groups an assignment", () => {
    const assigned = groupKey({ ...changed, assigned: true }, "task_assigned")
    expect(assigned).toBeNull()
    expect(shouldGroup({ groupKey: assigned, updatedAt: minutesAgo(1) }, { groupKey: assigned }, now)).toBe(false)
  })
})
