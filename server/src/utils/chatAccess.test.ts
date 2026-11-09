import { describe, expect, it } from "vitest"
import { chatAudience, chatCallPlan, isUnread, messagePreview, nextAdmin, serverInstant } from "./chatAccess"
import { roomKind } from "./meetingRooms"

const A = "b0000000-0000-4000-8000-000000000002"
const B = "a0000000-0000-4000-8000-000000000001"

describe("serverInstant", () => {
  it("reads a stored time without a zone as UTC and keeps a given zone", () => {
    const tenUtc = Date.UTC(2026, 9, 24, 10)
    expect(serverInstant("2026-10-24 10:00:00")).toBe(tenUtc)
    expect(serverInstant("2026-10-24T10:00:00.000Z")).toBe(tenUtc)
    expect(serverInstant("2026-10-24T12:00:00+02:00")).toBe(tenUtc)
    expect(serverInstant("2026-10-24T12:00:00+0200")).toBe(tenUtc)
  })
})

describe("isUnread", () => {
  it("is unread when there is a message and no read point", () => {
    expect(isUnread("2026-10-24 10:00:00", null)).toBe(true)
  })

  it("is read when the read point is after the message", () => {
    expect(isUnread("2026-10-24 10:00:00", "2026-10-24 10:05:00")).toBe(false)
    expect(isUnread("2026-10-24 10:00:00", "2026-10-24 10:00:00")).toBe(false)
  })

  it("is unread when a message came after the read point", () => {
    expect(isUnread("2026-10-24 10:10:00", "2026-10-24 10:05:00")).toBe(true)
  })

  it("is read when nobody else has written", () => {
    expect(isUnread(null, null)).toBe(false)
    expect(isUnread(null, "2026-10-24 10:05:00")).toBe(false)
  })
})

describe("nextAdmin", () => {
  const member = (id: string, role = "member") => ({ id, userId: `u-${id}`, role })

  it("promotes the oldest member when no admin is left", () => {
    expect(nextAdmin([member("1"), member("2")])).toBe("1")
  })

  it("prefers the given user when they are still there", () => {
    expect(nextAdmin([member("1"), member("2")], "u-2")).toBe("2")
    expect(nextAdmin([member("1")], "u-9")).toBe("1")
  })

  it("changes nothing while an admin remains or nobody does", () => {
    expect(nextAdmin([member("1"), member("2", "admin")])).toBeNull()
    expect(nextAdmin([])).toBeNull()
  })
})

describe("chatAudience", () => {
  it("is both users of a DM", () => {
    expect(chatAudience({ kind: "dm", a: A, b: B }).sort()).toEqual([A, B].sort())
  })

  it("is every group member, the sender included, once each", () => {
    expect(chatAudience({ kind: "group", memberIds: [A, B, A] }).sort()).toEqual([A, B].sort())
  })
})

describe("chatCallPlan", () => {
  const ORG = "c0ffee12-0000-4000-8000-000000000001"
  const room = `oc0ffee12-dm-${B}-${A}`

  it("puts a DM in its sorted workspace dm room and posts", () => {
    expect(chatCallPlan(ORG, { kind: "dm", a: A, b: B }, null)).toEqual({ roomName: room, post: true })
  })

  it("rejoins a DM's live room without posting, under its old name too", () => {
    expect(chatCallPlan(ORG, { kind: "dm", a: A, b: B }, room)).toEqual({ roomName: room, post: false })
    expect(chatCallPlan(ORG, { kind: "dm", a: A, b: B }, `dm-${B}-${A}`)).toEqual({ roomName: `dm-${B}-${A}`, post: false })
  })

  it("opens a new workspace room for a group and posts", () => {
    const plan = chatCallPlan(ORG, { kind: "group", memberIds: [A, B] }, null)
    expect(roomKind(plan.roomName)).toEqual({ kind: "instant", org: "c0ffee12" })
    expect(plan.post).toBe(true)
  })

  it("reuses a live room without posting", () => {
    const live = "c0000000-0000-4000-8000-000000000003"
    expect(chatCallPlan(ORG, { kind: "group", memberIds: [A, B] }, live)).toEqual({ roomName: live, post: false })
  })
})

describe("messagePreview", () => {
  it("is plain text cut to 120 characters, and a call reads as started", () => {
    expect(messagePreview("text", "  hello\n\n there ")).toBe("hello there")
    expect(Array.from(messagePreview("text", "x".repeat(300))).length).toBe(120)
    expect(messagePreview("call", "")).toBe("Call started")
  })

  it("reads mentions as names before cutting, and an unknown user as Someone", () => {
    const names = new Map([[A, "Anna Berg"]])
    expect(messagePreview("text", `hi @[${A.toUpperCase()}] and @[${B}]`, names)).toBe("hi @Anna Berg and @Someone")
    expect(messagePreview("text", `${"x".repeat(110)} @[${A}]`, names)).toBe(`${"x".repeat(110)} @Anna Ber`)
  })
})
