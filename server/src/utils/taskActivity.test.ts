import { describe, expect, it } from "vitest"
import { activityLabel, diffTaskActivity, type ActivitySource } from "./taskActivity"

const base: ActivitySource = {
  status: "todo",
  priority: "medium",
  assignedTo: "user-a",
  dueDate: "2026-10-20 00:00:00",
  projectId: "project-a",
}

describe("diffTaskActivity", () => {
  it("returns nothing for identical input", () => {
    expect(diffTaskActivity(base, { ...base })).toEqual([])
  })

  it("returns one entry per changed field in a fixed order", () => {
    const after: ActivitySource = {
      status: "done",
      priority: "urgent",
      assignedTo: null,
      dueDate: "2026-10-21T00:00:00.000Z",
      projectId: null,
    }

    expect(diffTaskActivity(base, after)).toEqual([
      { field: "status", from: "todo", to: "done" },
      { field: "priority", from: "medium", to: "urgent" },
      { field: "assignee", from: "user-a", to: null },
      { field: "due_date", from: "2026-10-20", to: "2026-10-21" },
      { field: "project", from: "project-a", to: null },
    ])
  })

  it.each([
    ["treats empty and null due dates as equal", "", null],
    ["ignores a due date that only changes format within the same day", "2026-10-20T00:00:00.000Z", "2026-10-20"],
  ])("%s", (_name, before, after) => {
    expect(diffTaskActivity({ ...base, dueDate: before }, { ...base, dueDate: after })).toEqual([])
  })
})

describe("activityLabel", () => {
  it("names only the viewer's projects", () => {
    const names = { users: new Map(), projects: new Map([["mine", "Website"]]) }
    expect(activityLabel("project", "mine", names)).toBe("Website")
    expect(activityLabel("project", "hidden", names)).toBe("another project")
  })
})
