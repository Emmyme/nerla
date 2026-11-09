import { describe, expect, it } from "vitest"
import { fillGrid, stageLayout, type StageTile } from "./stage"

const cam = (participant: string, publishedAt = 0): StageTile => ({
  key: `${participant}:camera`,
  participant,
  source: "camera",
  publishedAt,
})
const screen = (participant: string, publishedAt: number): StageTile => ({
  key: `${participant}:screen`,
  participant,
  source: "screen",
  publishedAt,
})
const me: StageTile = { ...cam("me"), local: true }

const keys = (tiles: StageTile[]) => tiles.map((t) => t.key)

describe("stageLayout", () => {
  it("shows a grid when nothing is shared or pinned", () => {
    const tiles = [cam("a"), cam("b"), cam("c")]
    expect(stageLayout(tiles, { mode: "grid" })).toEqual({ kind: "grid", tiles })
  })

  it("focuses a screen share with the cameras in the strip", () => {
    const tiles = [cam("a"), cam("b"), screen("b", 5)]
    const layout = stageLayout(tiles, { mode: "grid" })
    expect(layout.kind).toBe("focus")
    if (layout.kind !== "focus") return
    expect(layout.main.key).toBe("b:screen")
    expect(keys(layout.strip)).toEqual(["a:camera", "b:camera"])
  })

  it("puts the newest of two screen shares on the main tile", () => {
    const tiles = [cam("a"), screen("a", 10), cam("b"), screen("b", 20)]
    const layout = stageLayout(tiles, { mode: "grid" })
    if (layout.kind !== "focus") throw new Error("expected focus")
    expect(layout.main.key).toBe("b:screen")
    expect(keys(layout.strip)).toEqual(["a:camera", "a:screen", "b:camera"])
  })

  it("focuses a pinned tile when nothing is shared", () => {
    const tiles = [cam("a"), cam("b"), cam("c")]
    const layout = stageLayout(tiles, { mode: "grid", pinned: "b:camera" })
    if (layout.kind !== "focus") throw new Error("expected focus")
    expect(layout.main.key).toBe("b:camera")
    expect(keys(layout.strip)).toEqual(["a:camera", "c:camera"])
  })

  it("follows the active speaker in speaker mode and falls back to a remote tile, never the local one", () => {
    const tiles = [me, cam("a"), cam("b")]
    const layout = stageLayout(tiles, { mode: "speaker", activeSpeaker: "b" })
    if (layout.kind !== "focus") throw new Error("expected focus")
    expect(layout.main.key).toBe("b:camera")
    for (const activeSpeaker of [undefined, "me", "gone"]) {
      const fallback = stageLayout(tiles, { mode: "speaker", activeSpeaker })
      if (fallback.kind !== "focus") throw new Error("expected focus")
      expect(fallback.main.key).toBe("a:camera")
    }
  })

  it("shows the local tile on the main tile only when it is alone", () => {
    expect(stageLayout([me], { mode: "speaker" })).toEqual({ kind: "focus", main: me, strip: [] })
  })

  it("puts the remote tile on the main tile with the local one in the corner when there are two", () => {
    expect(stageLayout([me, cam("a")], { mode: "grid" })).toEqual({ kind: "pair", main: cam("a"), self: me })
    expect(stageLayout([me, cam("a"), cam("b")], { mode: "grid" }).kind).toBe("grid")
  })

  it("shows a presenting card for the local share and lets a newer remote share take the stage", () => {
    const mine = { ...screen("me", 5), local: true }
    const layout = stageLayout([me, cam("a"), mine], { mode: "grid" })
    expect(layout).toEqual({ kind: "presenting", share: mine, strip: [me, cam("a")] })
    const theirs = stageLayout([me, cam("a"), mine, screen("a", 9)], { mode: "grid" })
    if (theirs.kind !== "focus") throw new Error("expected focus")
    expect(theirs.main.key).toBe("a:screen")
  })

  it("lets a pin win over speaker mode", () => {
    const tiles = [cam("a"), cam("b"), cam("c")]
    const layout = stageLayout(tiles, { mode: "speaker", pinned: "b:camera", activeSpeaker: "c" })
    if (layout.kind !== "focus") throw new Error("expected focus")
    expect(layout.main.key).toBe("b:camera")
  })

  it("lets a screen share win over a pin", () => {
    const tiles = [cam("a"), cam("b"), screen("a", 3)]
    const layout = stageLayout(tiles, { mode: "speaker", pinned: "b:camera", activeSpeaker: "b" })
    if (layout.kind !== "focus") throw new Error("expected focus")
    expect(layout.main.key).toBe("a:screen")
  })

  it("focuses a single tile in speaker mode", () => {
    const tiles = [cam("a")]
    expect(stageLayout(tiles, { mode: "speaker" })).toEqual({ kind: "focus", main: tiles[0], strip: [] })
  })
})

describe("fillGrid", () => {
  it("stacks two people and puts three or four in two columns", () => {
    expect(fillGrid(2)).toEqual({ cols: 1, rows: 2 })
    expect(fillGrid(3)).toEqual({ cols: 2, rows: 2 })
    expect(fillGrid(4)).toEqual({ cols: 2, rows: 2 })
  })
})
