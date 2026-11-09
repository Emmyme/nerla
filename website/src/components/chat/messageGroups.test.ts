import { describe, expect, it } from "vitest"
import type { ChatMessage } from "@/lib/api/chat"
import { groupMessages } from "./messageGroups"

function message(id: string, at: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sender_id: "jane",
    recipient_id: null,
    thread_type: "group",
    thread_id: "g1",
    kind: "text",
    meta: null,
    live: false,
    content: id,
    is_read: false,
    is_edited: false,
    edited_at: null,
    created_at: at,
    reply_to_id: null,
    is_pinned: false,
    pinned_at: null,
    reply_to: null,
    sender: null,
    attachments: [],
    reactions: [],
    ...overrides,
  }
}

const now = new Date("2026-10-22T10:00:00Z")
const ids = (blocks: ReturnType<typeof groupMessages>) =>
  blocks.map((block) => (block.kind === "day" ? block.label : block.items.map((m) => m.id).join(",")))

describe("groupMessages", () => {
  it("groups one sender's messages within 5 minutes", () => {
    const blocks = groupMessages(
      [message("a", "2026-10-22 08:00:00"), message("b", "2026-10-22 08:03:00"), message("c", "2026-10-22 08:07:30")],
      now,
    )
    expect(ids(blocks)).toEqual(["Today", "a,b,c"])
    expect(blocks[1]).toMatchObject({ kind: "group", senderId: "jane" })
  })

  it("starts a new group after more than 5 minutes", () => {
    const blocks = groupMessages([message("a", "2026-10-22 08:00:00"), message("b", "2026-10-22 08:05:01")], now)
    expect(ids(blocks)).toEqual(["Today", "a", "b"])
  })

  it("starts a new group when the sender changes", () => {
    const blocks = groupMessages(
      [message("a", "2026-10-22 08:00:00"), message("b", "2026-10-22 08:01:00", { sender_id: "bob" }), message("c", "2026-10-22 08:02:00")],
      now,
    )
    expect(ids(blocks)).toEqual(["Today", "a", "b", "c"])
    expect(blocks.slice(1).map((block) => block.kind === "group" && block.senderId)).toEqual(["jane", "bob", "jane"])
  })

  it("separates days at local midnight in Europe/Stockholm", () => {
    // 23:58 and 00:01 Stockholm time are 21:58 and 22:01 UTC in October
    const blocks = groupMessages(
      [
        message("old", "2025-10-22 09:00:00"),
        message("wed", "2026-10-14 09:00:00"),
        message("a", "2026-10-21 21:58:00"),
        message("b", "2026-10-21 22:01:00"),
      ],
      now,
    )
    expect(ids(blocks)).toEqual(["22 Oct 2025", "old", "Wed 14 Oct", "wed", "Yesterday", "a", "Today", "b"])
  })

  it("keeps local days right across the end of summer time", () => {
    // Stockholm leaves summer time on 25 Oct 2026, so midnight is 22:00 UTC before it and 23:00 UTC after
    const blocks = groupMessages(
      [
        message("a", "2026-10-24 21:59:00"),
        message("b", "2026-10-24 22:01:00"),
        message("c", "2026-10-25 22:59:00"),
        message("d", "2026-10-25 23:01:00"),
      ],
      new Date("2026-10-26T10:00:00Z"),
    )
    expect(ids(blocks)).toEqual(["Sat 24 Oct", "a", "Yesterday", "b", "c", "Today", "d"])
  })

  it("keeps a call message on its own", () => {
    const blocks = groupMessages(
      [
        message("a", "2026-10-22 08:00:00"),
        message("call", "2026-10-22 08:01:00", { kind: "call", content: "", meta: { roomName: "room" } }),
        message("b", "2026-10-22 08:02:00"),
      ],
      now,
    )
    expect(ids(blocks)).toEqual(["Today", "a", "call", "b"])
  })
})
