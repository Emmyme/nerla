// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({ value: false }))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => tauri.value }))

import { callChat, dmRoom, joinLink, meetingPath } from "./meetingWindow"

afterEach(() => {
  tauri.value = false
  localStorage.clear()
})

describe("joinLink", () => {
  it("uses the page's origin in a browser and the connected server in the desktop app", () => {
    expect(joinLink("meeting-1")).toBe(`${window.location.origin}/join/meeting-1`)
    tauri.value = true
    localStorage.setItem("nerla_server_url", "https://nerla.example.com")
    expect(joinLink("meeting-1")).toBe("https://nerla.example.com/join/meeting-1")
  })
})

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
