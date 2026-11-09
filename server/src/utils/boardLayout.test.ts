import { describe, expect, it } from "vitest"
import { boardElements } from "./boardElements"
import { checkPlan, layoutBoard, within, type BoardPlan, type Box, type PlanItem } from "./boardLayout"

type El = Record<string, any>

const counter = () => {
  let n = 0
  return { newId: () => `e${++n}` }
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const LAYOUTS = ["clusters", "mind_map", "columns", "flow"] as const
const KINDS = ["note", "rectangle", "text", "ellipse", "heading", "diamond"] as const

function sample(layout: BoardPlan["layout"]): BoardPlan {
  const items: PlanItem[] = [{ id: "hub", kind: "note", text: "The launch" }]
  ;[8, 5, 1].forEach((count, g) => {
    for (let i = 0; i < count; i++) {
      const text = i === 2 ? "A longer thought that wraps over a few lines of the item ".repeat(3).trim() : `Idea ${g}.${i}`
      items.push({ id: `g${g}i${i}`, kind: KINDS[(g + i) % KINDS.length], text, group: `g${g}` })
    }
  })
  return {
    items,
    groups: [
      { id: "g0", title: "Ideas", frame: true },
      { id: "g1", title: "Questions" },
      { id: "g2", frame: true },
    ],
    connections: [
      { from: "hub", to: "g0i0", kind: "arrow", label: "starts with" },
      { from: "g0i1", to: "g1i1", kind: "line", label: "raises" },
      { from: "g0i0", to: "g0i4", kind: "arrow", label: "leads to the next idea" },
    ],
    layout,
    center: layout === "mind_map" ? "hub" : undefined,
  }
}

const textOf = (elements: El[], text: string) => elements.find((el) => el.type === "text" && el.originalText === text)!
const byId = (elements: El[], id: string) => elements.find((el) => el.id === id)!

describe("layoutBoard", () => {
  it("never overlaps in any layout", () => {
    for (const layout of LAYOUTS) {
      const plan = sample(layout)
      const placed = layoutBoard(plan, [])
      const framed = new Map(plan.items.map((item) => [item.id, item.group]))
      const items = [...placed.items]
      const frames = [...placed.frames]
      const titles = [...placed.titles.values()]
      expect(items).toHaveLength(plan.items.length)
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++)
          expect(overlaps(items[i][1], items[j][1]), `${layout} ${items[i][0]} ${items[j][0]}`).toBe(false)
        for (const [group, frame] of frames)
          if (framed.get(items[i][0]) !== group) expect(overlaps(items[i][1], frame), `${layout} ${items[i][0]}`).toBe(false)
        for (const title of titles) expect(overlaps(items[i][1], title)).toBe(false)
      }
      for (let i = 0; i < frames.length; i++) {
        for (let j = i + 1; j < frames.length; j++) expect(overlaps(frames[i][1], frames[j][1]), layout).toBe(false)
        for (const title of titles) expect(overlaps(frames[i][1], title)).toBe(false)
      }
      const elements = boardElements(plan, placed, counter())
      const arrows = new Set(elements.filter((el) => el.type === "arrow").map((el) => el.id))
      const labels = elements.filter((el): el is El & Box => arrows.has(el.containerId))
      expect(labels).toHaveLength(3)
      labels.forEach((label, i) => {
        for (const box of [...placed.items.values(), ...titles, ...labels.slice(i + 1)])
          expect(overlaps(label, box), `${layout} ${label.text}`).toBe(false)
        for (const [, frame] of frames) expect(within(label, frame) || !overlaps(label, frame), `${layout} ${label.text}`).toBe(true)
      })
    }
  })

  it("puts new content beside an existing board", () => {
    const existing: Box[] = [
      { x: 0, y: 300, width: 400, height: 200 },
      { x: 600, y: 100, width: 300, height: 120 },
    ]
    const before = structuredClone(existing)
    const placed = layoutBoard(sample("clusters"), existing)
    const boxes = [...placed.items.values(), ...placed.frames.values(), ...placed.titles.values()]
    for (const box of boxes) expect(box.x).toBeGreaterThanOrEqual(1060)
    expect(Math.min(...boxes.map((box) => box.y))).toBe(100)
    expect(existing).toEqual(before)
  })

  it("grows a note to fit its text", () => {
    const text = "word ".repeat(56).trim().padEnd(280, "x")
    const plan: BoardPlan = { items: [{ id: "a", kind: "note", text }], groups: [], connections: [], layout: "flow" }
    const placed = layoutBoard(plan, [])
    const box = placed.items.get("a")!
    expect(box.height).toBeGreaterThan(200)
    const label = textOf(boardElements(plan, placed, counter()), text)
    for (const line of label.text.split("\n")) expect(line.length * 20 * 0.6).toBeLessThanOrEqual(box.width - 48)
    expect(label.height).toBeLessThanOrEqual(box.height)
  })

  it("frames a group around its items", () => {
    const plan = sample("clusters")
    const placed = layoutBoard(plan, [])
    const elements = boardElements(plan, placed, counter())
    const frameBox = placed.frames.get("g0")!
    const frame = elements.find((el) => el.type === "frame" && el.name === "Ideas")!
    for (const item of plan.items.filter((each) => each.group === "g0")) {
      const box = placed.items.get(item.id)!
      expect(box.x).toBeGreaterThanOrEqual(frameBox.x)
      expect(box.y).toBeGreaterThanOrEqual(frameBox.y)
      expect(box.x + box.width).toBeLessThanOrEqual(frameBox.x + frameBox.width)
      expect(box.y + box.height).toBeLessThanOrEqual(frameBox.y + frameBox.height)
      const label = textOf(elements, item.text)
      const shape = label.containerId ? byId(elements, label.containerId) : label
      expect(shape.frameId).toBe(frame.id)
    }
  })
})

describe("boardElements", () => {
  const two: BoardPlan = {
    items: [
      { id: "a", kind: "note", text: "First" },
      { id: "b", kind: "note", text: "Second", color: "lemon" },
    ],
    groups: [],
    connections: [{ from: "a", to: "b", kind: "arrow" }],
    layout: "flow",
  }

  it("binds an arrow at both ends", () => {
    const elements = boardElements(two, layoutBoard(two, []), counter())
    const arrow = elements.find((el) => el.type === "arrow")!
    const first = byId(elements, textOf(elements, "First").containerId)
    const second = byId(elements, textOf(elements, "Second").containerId)
    expect(arrow.startBinding).toEqual({ elementId: first.id, focus: 0, gap: 8 })
    expect(arrow.endBinding).toEqual({ elementId: second.id, focus: 0, gap: 8 })
    expect(first.boundElements).toContainEqual({ type: "arrow", id: arrow.id })
    expect(second.boundElements).toContainEqual({ type: "arrow", id: arrow.id })
  })

  it("draws a sticky note as the button does", () => {
    const elements = boardElements(two, layoutBoard(two, []), counter())
    const label = textOf(elements, "Second")
    const note = byId(elements, label.containerId)
    expect(note).toMatchObject({
      type: "rectangle",
      backgroundColor: "#FFF1A8",
      strokeColor: "#F5C542",
      fillStyle: "solid",
      strokeWidth: 1,
      roughness: 0,
      roundness: { type: 3 },
      version: 1,
      index: null,
    })
    expect(note.boundElements).toContainEqual({ type: "text", id: label.id })
    expect(label).toMatchObject({ textAlign: "center", verticalAlign: "middle" })
  })
})

describe("checkPlan", () => {
  it("refuses over the caps", () => {
    const items = Array.from({ length: 61 }, (_, i): PlanItem => ({ id: `n${i}`, kind: "note", text: "Hi" }))
    expect(checkPlan({ items, groups: [], connections: [], layout: "clusters" })).toBe(
      "A board call can place at most 60 items, 80 connections and 12 groups",
    )
  })

  it("refuses a mind map whose center is in a group", () => {
    const plan = sample("mind_map")
    expect(checkPlan(plan)).toBeNull()
    expect(checkPlan({ ...plan, center: "g0i0" })).toBe("The center can't be in a group")
  })
})
