import { describe, expect, it } from "vitest"
import type { TaskActivity, TaskComment } from "@/lib/api/tasks"
import type { UserSummary } from "@/lib/api/users"
import { describeActivity, mergeFeed } from "./taskFeed"

const alice: UserSummary = { id: "alice", first_name: "Alice", last_name: "Lane", avatar_url: null }
const me: UserSummary = { id: "me", first_name: "John", last_name: "Doe", avatar_url: null }

function activity(id: string, created_at: string, overrides: Partial<TaskActivity> = {}): TaskActivity {
  return {
    id,
    field: "status",
    from_value: "todo",
    to_value: "in_progress",
    from_label: "todo",
    to_label: "in_progress",
    created_at,
    user: alice,
    ...overrides,
  }
}

function comment(id: string, created_at: string): TaskComment {
  return {
    id,
    task_id: "t",
    user_id: "alice",
    content: id,
    created_at,
    updated_at: created_at,
    user: { id: "alice", email: "alice@nerla.com", first_name: "Alice", last_name: "Lane", avatar_url: null },
    attachments: [],
  }
}

const task = { id: "t", created_at: "2026-10-20 09:00:00", created_by: "me" }
const keys = (items: { key: string }[]) => items.map((item) => item.key)
const text = (segments: { text: string }[]) => segments.map((segment) => segment.text).join("")

describe("mergeFeed", () => {
  it("starts with the created line and merges activity and comments by time", () => {
    const feed = mergeFeed(
      [activity("a1", "2026-10-21 10:00:00"), activity("a2", "2026-10-23 08:00:00")],
      [comment("c1", "2026-10-22 12:00:00"), comment("c2", "2026-10-20 09:30:00")],
      task,
    )
    expect(keys(feed)).toEqual(["created:t", "comment:c2", "activity:a1", "comment:c1", "activity:a2"])
  })

  it("keeps the server order for rows that share a timestamp and puts unreadable times last", () => {
    const at = "2026-10-21 10:00:00.123"
    const feed = mergeFeed(
      [activity("status", at), activity("priority", at), activity("assignee", at), activity("broken", "garbage")],
      [comment("c1", "2026-10-21 10:00:00.123"), comment("c0", "2026-10-21 09:00:00")],
      task,
    )
    expect(keys(feed)).toEqual([
      "created:t",
      "comment:c0",
      "activity:status",
      "activity:priority",
      "activity:assignee",
      "comment:c1",
      "activity:broken",
    ])
  })
})

describe("describeActivity", () => {
  it("writes a sentence per field with readable values", () => {
    expect(text(describeActivity(activity("1", "2026-10-21"), "me"))).toBe("Alice changed status from To do to In progress")
    expect(
      text(
        describeActivity(
          activity("2", "2026-10-21", { field: "priority", from_value: "none", to_value: "high", from_label: "none", to_label: "high" }),
          "me",
        ),
      ),
    ).toBe("Alice set priority to High")
    expect(
      text(
        describeActivity(
          activity("3", "2026-10-21", { field: "assignee", from_value: null, to_value: "me", from_label: null, to_label: "John Doe" }),
          "me",
        ),
      ),
    ).toBe("Alice assigned this to you")
    expect(
      text(
        describeActivity(
          activity("4", "2026-10-21", {
            field: "assignee",
            from_value: "alice",
            to_value: null,
            from_label: "Alice Lane",
            to_label: null,
            user: me,
          }),
          "me",
        ),
      ),
    ).toBe("You unassigned Alice Lane")
    expect(
      text(
        describeActivity(
          activity("5", "2026-10-21", {
            field: "due_date",
            from_value: "2026-10-25",
            to_value: null,
            from_label: "2026-10-25",
            to_label: null,
          }),
          "me",
        ),
      ),
    ).toBe("Alice removed the due date")
    expect(
      text(
        describeActivity(
          activity("6", "2026-10-21", {
            field: "project",
            from_value: "p1",
            to_value: null,
            from_label: "Website",
            to_label: "Personal",
            user: null,
          }),
          "me",
        ),
      ),
    ).toBe("Someone moved this from Website to Personal")
  })
})
