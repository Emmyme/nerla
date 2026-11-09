import { describe, expect, it } from "vitest"
import { callChat, dmRoom, meetingPath } from "./meetingWindow"

const A = "a0000000-0000-4000-8000-000000000001"
const B = "B0000000-0000-4000-8000-000000000002"
const G = "c0000000-0000-4000-8000-000000000003"
const ORG = "C0FFEE12-0000-4000-8000-000000000001"

describe("dmRoom", () => {
  it("is the same workspace room whoever calls, as the server names it", () => {
    expect(dmRoom(ORG, B, A)).toBe(`oc0ffee12-dm-${A}-${B.toLowerCase()}`)
    expect(dmRoom(ORG, A, B)).toBe(dmRoom(ORG, B, A))
  })
})

describe("call chat", () => {
  it("round-trips the chat through the window link", () => {
    const path = meetingPath("room-1", { kind: "group", id: G })
    const search = new URLSearchParams(path.split("?")[1])
    expect(callChat(search, "room-1", A)).toEqual({ kind: "group", id: G })
    expect(meetingPath("room-1")).toBe("/meeting-room/room-1")
  })

  it("falls back to the other user of a 1:1 room, and ignores anything else", () => {
    const none = new URLSearchParams()
    expect(callChat(none, dmRoom(ORG, A, B), A)).toEqual({ kind: "dm", id: B.toLowerCase() })
    expect(callChat(none, `dm-${A}-${B.toLowerCase()}`, A)).toEqual({ kind: "dm", id: B.toLowerCase() })
    expect(callChat(none, dmRoom(ORG, A, B), G)).toBeNull()
    expect(callChat(none, "meeting-x", A)).toBeNull()
    expect(callChat(new URLSearchParams("from=chat&chat=dm:nope"), "meeting-x", A)).toBeNull()
  })
})
