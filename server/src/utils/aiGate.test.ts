import { describe, expect, it, vi } from "vitest"

// The tool modules load with the real tables and no database connection
vi.mock("../db", async () => ({ ...(await import("../db/schema")), db: {} }))
vi.mock("../services/storage", () => ({}))

import { scopeAllows } from "../services/aiGate"
import { toolByName, type ToolContext } from "../services/aiTools"
import { effectiveStrictness, isTainting, needsAllow, takeBatch, trashRefusals, type HeldItem } from "./aiGate"
import type { Strictness } from "./aiTypes"

const gatedBy = async (name: string, args: unknown) => (await toolByName(name)!.alwaysGated?.(args, {} as ToolContext)) ?? false

const write = (strictness: Strictness, tainted: boolean, othersCanSee: boolean, alwaysGated = false) =>
  needsAllow({ write: true, alwaysGated, strictness, tainted, othersCanSee })

describe("taint", () => {
  it("is anything the asker did not write", () => {
    expect(isTainting(["me"], "me")).toBe(false)
    expect(isTainting(["me", "theo"], "me")).toBe(true)
    expect(isTainting([null], "me")).toBe(true)
  })
})

describe("the strict rule", () => {
  it("holds a tainted write others see, and nothing else", () => {
    expect(write("tainted", true, true)).toBe(true)
    expect(write("tainted", true, false)).toBe(false)
    expect(write("tainted", false, true)).toBe(false)
  })
})

describe("each level", () => {
  it("holds what its level says", () => {
    expect(write("every", false, false)).toBe(true)
    expect(write("sensitive", true, true)).toBe(false)
    expect(needsAllow({ write: false, alwaysGated: false, strictness: "every", tainted: true, othersCanSee: true })).toBe(false)
  })

  it("always holds a message and an invite, and not an event without attendees", async () => {
    const message = await gatedBy("post_message", { kind: "group", id: "g", content: "hi" })
    const invite = await gatedBy("create_event", {
      title: "Planning",
      start: "2026-11-03T10:00:00Z",
      end: "2026-11-03T11:00:00Z",
      attendee_ids: ["theo"],
    })
    const alone = await gatedBy("create_event", { title: "Focus", start: "2026-11-03T10:00:00Z", end: "2026-11-03T11:00:00Z" })
    for (const level of ["every", "tainted", "sensitive"] as const) {
      expect(write(level, false, true, message)).toBe(true)
      expect(write(level, false, true, invite)).toBe(true)
    }
    expect(write("sensitive", true, false, alone)).toBe(false)
  })
})

describe("trash changes", () => {
  it("lets one trash change through per turn", () => {
    expect(trashRefusals(["delete_task", "list_tasks", "delete_task", "restore_from_trash"])).toEqual([2, 3])
  })

  it("lets a single delete through", () => {
    expect(trashRefusals(["delete_task"])).toEqual([])
    expect(trashRefusals(["list_tasks", "delete_task", "list_tasks", "delete_doc"])).toEqual([3])
    expect(trashRefusals(["list_tasks", "create_task"])).toEqual([])
  })
})

describe("personal levels", () => {
  it("lets the stricter one win", () => {
    expect(effectiveStrictness("tainted", "every")).toBe("every")
    expect(effectiveStrictness("every", "sensitive")).toBe("every")
    expect(effectiveStrictness("sensitive", null)).toBe("sensitive")
  })

  it("counts a stored level the code doesn't know as the strictest", () => {
    expect(effectiveStrictness("retired" as Strictness, "sensitive")).toBe("every")
  })
})

describe("takeBatch", () => {
  const items: HeldItem[] = ["a", "b", "c"].map((id) => ({ id, tool: "create_task", args: { title: id }, summary: `Create task ${id}` }))
  const now = new Date("2026-10-28T10:00:00Z")
  const waiting = { status: "waiting", items, expiresAt: "2026-10-28 10:05:00" }

  it("runs the chosen items once each, in the card's order", () => {
    expect(takeBatch(waiting, ["c", "a"], now)).toEqual({ run: [items[0], items[2]] })
  })

  it("refuses anything off the card, answered or timed out", () => {
    expect(takeBatch(waiting, ["x"], now)).toEqual({ error: "not-on-card" })
    expect(takeBatch(waiting, ["a", "x"], now)).toEqual({ error: "not-on-card" })
    expect(takeBatch({ ...waiting, status: "expired" }, ["a"], now)).toEqual({ error: "timed-out" })
    expect(takeBatch({ ...waiting, expiresAt: "2026-10-28 10:00:00" }, ["a"], now)).toEqual({ error: "timed-out" })
    expect(takeBatch({ ...waiting, status: "done" }, ["a"], now)).toEqual({ error: "gone" })
    expect(takeBatch({ ...waiting, expiresAt: "2026-10-28 09:59:59" }, ["a"], now)).toEqual({ error: "timed-out" })
  })
})

describe("agent token scopes", () => {
  const ID = "6f1d3c4e-2a7b-4c8d-9e0f-1a2b3c4d5e6f"
  const agent = (areas: Record<string, "read" | "write">, readOnly = false) => ({ scopes: { areas, readOnly } }) as unknown as ToolContext
  const restore = toolByName("restore_from_trash")!

  it("reach only the area a call names, and write only with a write scope", () => {
    expect(scopeAllows(agent({ tasks: "write" }), restore, { kind: "task", id: ID })).toBe(true)
    expect(scopeAllows(agent({ tasks: "write" }), restore, { kind: "file", id: ID })).toBe(false)
    expect(scopeAllows(agent({ tasks: "write" }), restore, { kind: "nothing", id: ID })).toBe(false)
    expect(scopeAllows(agent({ tasks: "read" }), restore, { kind: "task", id: ID })).toBe(false)
    expect(scopeAllows(agent({ tasks: "write" }, true), restore, { kind: "task", id: ID })).toBe(false)
    expect(scopeAllows(agent({ tasks: "read" }), toolByName("list_tasks")!, {})).toBe(true)
  })

  it("list a tool for any area it could reach, and leave the AI teammate unscoped", () => {
    expect(scopeAllows(agent({ files: "write" }), restore)).toBe(true)
    expect(scopeAllows(agent({ files: "read" }), restore)).toBe(false)
    expect(scopeAllows({ scopes: null } as unknown as ToolContext, restore, { kind: "file", id: ID })).toBe(true)
  })
})
