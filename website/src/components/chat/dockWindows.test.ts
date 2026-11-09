import { describe, expect, it } from "vitest"
import { closeWindow, entryKey, openWindow, parseDock, pruneWindows, setMinimized, type DockEntry } from "./dockWindows"

const chat = (id: string) => ({ kind: "dm" as const, id })

describe("dock windows", () => {
  it("keeps three windows and a fourth replaces the oldest", () => {
    let list: DockEntry[] = []
    for (const id of ["a", "b", "c", "d"]) list = openWindow(list, chat(id))
    expect(list.map((w) => w.id)).toEqual(["b", "c", "d"])
  })

  it("raises an open chat to the newest place without adding it twice", () => {
    let list = openWindow(openWindow(openWindow([], chat("a")), chat("b")), chat("c"))
    list = setMinimized(list, entryKey(chat("a")), true)
    expect(list[0].minimized).toBe(true)
    list = openWindow(list, { ...chat("A") })
    expect(list.map((w) => [w.id, w.minimized])).toEqual([
      ["b", false],
      ["c", false],
      ["a", false],
    ])
    // With room for two, the raised chat is among the ones shown
    expect(list.slice(-2).map((w) => w.id)).toContain("a")
    expect(closeWindow(list, entryKey(chat("a"))).map((w) => w.id)).toEqual(["b", "c"])
  })

  it("drops windows for groups the list no longer has, never a DM or a chat just made", () => {
    const group = (id: string) => ({ kind: "group" as const, id, minimized: false })
    const list = [group("left"), group("kept"), group("new"), { ...chat("d"), minimized: false }]
    const listed = new Set(["group:kept"])
    expect(pruneWindows(list, listed, new Set(["group:new"])).map((w) => w.id)).toEqual(["kept", "new", "d"])
    const same = [group("kept")]
    expect(pruneWindows(same, listed, new Set())).toBe(same)
  })

  it("reads back only valid saved windows, without extra fields such as titles", () => {
    const saved = JSON.stringify([
      { kind: "group", id: "G1", title: "Team", minimized: true },
      { kind: "dm", id: "x", minimized: "no" },
      { kind: "other", id: "y", minimized: false },
      { kind: "group", id: "g1", minimized: false },
    ])
    expect(parseDock(saved)).toEqual([{ kind: "group", id: "g1", minimized: true }])
    expect(parseDock("{not json")).toEqual([])
    expect(parseDock(null)).toEqual([])
  })
})
