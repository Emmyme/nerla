import { describe, expect, it } from "vitest"
import { mergeLobby, type LobbyEntry } from "./lobby"

const ada: LobbyEntry = { sessionId: "a", guestName: "Ada" }
const bo: LobbyEntry = { sessionId: "b", guestName: "Bo" }
const cy: LobbyEntry = { sessionId: "c", guestName: "Cy" }

describe("mergeLobby", () => {
  it("appends a request after the ones already waiting", () => {
    expect(mergeLobby([ada], { type: "request", entry: bo })).toEqual([ada, bo])
  })

  it("ignores a request it already has", () => {
    const current = [ada, bo]
    expect(mergeLobby(current, { type: "request", entry: { sessionId: "a", guestName: "Ada again" } })).toBe(current)
  })

  it("removes a resolved request", () => {
    expect(mergeLobby([ada, bo], { type: "resolved", sessionId: "a" })).toEqual([bo])
    const current = [bo]
    expect(mergeLobby(current, { type: "resolved", sessionId: "missing" })).toBe(current)
  })

  it("merges a replay with requests that arrived after it was asked for, oldest first and without duplicates", () => {
    expect(mergeLobby([bo, cy], { type: "replay", entries: [ada, bo], newer: new Set(["c"]) })).toEqual([ada, bo, cy])
    const current = [ada]
    expect(mergeLobby(current, { type: "replay", entries: [ada] })).toBe(current)
  })

  it("drops older requests the replay no longer lists, since their outcome was missed", () => {
    expect(mergeLobby([ada, bo, cy], { type: "replay", entries: [bo], newer: new Set(["c"]) })).toEqual([bo, cy])
    expect(mergeLobby([ada], { type: "replay", entries: [] })).toEqual([])
  })
})
