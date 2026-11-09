import { describe, expect, it } from "vitest"
import type { Task } from "@/lib/api/tasks"
import type { UserSummary } from "@/lib/api/users"
import { groupTasks } from "./groupTasks"

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    identifier: null,
    number: null,
    project_id: null,
    project: null,
    title: id,
    description: null,
    status: "todo",
    priority: "none",
    assigned_to: null,
    assignee: null,
    created_by: null,
    position: 0,
    due_date: null,
    completed_at: null,
    created_at: "2026-10-23 10:00:00",
    updated_at: "2026-10-23 10:00:00",
    attachments: [],
    ...overrides,
  }
}

function user(id: string, first_name: string, last_name: string): UserSummary {
  return { id, first_name, last_name, avatar_url: null }
}

const keys = (groups: { key: string }[]) => groups.map((group) => group.key)
const ids = (tasks: Task[]) => tasks.map((t) => t.id)

describe("groupTasks", () => {
  it("orders status groups in progress, to do, backlog, done and keeps empty ones", () => {
    const groups = groupTasks([task("a", { status: "done" }), task("b", { status: "in_progress" })], "status")
    expect(keys(groups)).toEqual(["in_progress", "todo", "backlog", "done"])
    expect(groups.map((group) => group.label)).toEqual(["In progress", "To do", "Backlog", "Done"])
    expect(groups[1].tasks).toEqual([])
  })

  it("leaves out status groups that are not asked for", () => {
    const groups = groupTasks([task("a", { status: "todo" })], "status", ["in_progress", "todo", "done"])
    expect(keys(groups)).toEqual(["in_progress", "todo", "done"])
  })

  it("orders priority groups urgent to none and drops empty ones", () => {
    const groups = groupTasks(
      [task("a", { priority: "low" }), task("b", { priority: "none" }), task("c", { priority: "urgent" })],
      "priority",
    )
    expect(keys(groups)).toEqual(["urgent", "low", "none"])
    expect(groups[2].label).toBe("No priority")
  })

  it("orders assignee groups alphabetically with Unassigned last", () => {
    const zoe = user("u1", "Zoe", "Adams")
    const ann = user("u2", "Ann", "Berg")
    const groups = groupTasks(
      [
        task("a"),
        task("b", { assigned_to: zoe.id, assignee: zoe }),
        task("c", { assigned_to: ann.id, assignee: ann }),
        task("d", { assigned_to: zoe.id, assignee: zoe }),
      ],
      "assignee",
    )
    expect(groups.map((group) => group.label)).toEqual(["Ann Berg", "Zoe Adams", "Unassigned"])
    expect(ids(groups[1].tasks)).toEqual(["b", "d"])
  })

  it("sorts within a group by priority, then due date with missing and invalid dates last", () => {
    const [group] = groupTasks(
      [
        task("none-due", { priority: "high" }),
        task("low", { priority: "low", due_date: "2026-10-20" }),
        task("bad-due", { priority: "high", due_date: "not a date" }),
        task("late", { priority: "high", due_date: "2026-11-02" }),
        task("soon", { priority: "high", due_date: "2026-10-24" }),
        task("urgent", { priority: "urgent" }),
      ],
      "none",
    )
    expect(ids(group.tasks)).toEqual(["urgent", "soon", "late", "none-due", "bad-due", "low"])
  })
})
