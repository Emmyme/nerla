import { describe, expect, it } from "vitest"
import { visibleThreads } from "./docComments"

const row = (id: string, parentId: string | null = null) => ({ id, parentId, deletedAt: null })

describe("visibleThreads", () => {
  it("drops a hidden thread with every reply, later ones included, and keeps the others", () => {
    const rows = [row("a"), row("a1", "a"), row("b"), row("b1", "b"), row("a2", "a")]
    const threads = visibleThreads(rows, new Set(["a"]))
    expect(threads.map((thread) => thread.root.id)).toEqual(["b"])
    expect(threads[0].replies.map((reply) => reply.id)).toEqual(["b1"])
  })

  it("keeps a deleted root while it has a live reply and drops it once none is left", () => {
    const deleted = (id: string, parentId: string | null = null) => ({ id, parentId, deletedAt: "2026-10-28 10:00:00" })
    const rows = [deleted("a"), row("a1", "a"), deleted("a2", "a"), deleted("b"), deleted("b1", "b")]
    const threads = visibleThreads(rows, new Set())
    expect(threads.map((thread) => [thread.root.id, thread.root.deletedAt !== null, thread.replies.map((reply) => reply.id)])).toEqual([
      ["a", true, ["a1"]],
    ])
  })
})
