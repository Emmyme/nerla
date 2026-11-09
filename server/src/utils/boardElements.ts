import { randomInt } from "node:crypto"
import {
  FONT_SIZE,
  FRAME_TITLE,
  HEADING_SIZE,
  LABEL_SIZE,
  LABEL_WIDTH,
  LINE_HEIGHT,
  TEXT_WIDTH,
  linesSize,
  overlaps,
  shapeLines,
  textSize,
  within,
  wrap,
  type BoardPlan,
  type Box,
  type ItemKind,
  type Placed,
} from "./boardLayout"

/** Nerla's board colours, fill then edge. Lemon is the board's own Sticky note button */
export const BOARD_PALETTE = {
  lemon: { fill: "#FFF1A8", edge: "#F5C542" },
  sky: { fill: "#BFE3FF", edge: "#7CC2F7" },
  pistachio: { fill: "#D5EDB5", edge: "#A8D477" },
  lavender: { fill: "#DCD0FF", edge: "#B39CFF" },
  bubblegum: { fill: "#FF9CC8", edge: "#FF6FAE" },
} as const
export type PaletteName = keyof typeof BOARD_PALETTE

type Element = Record<string, unknown> & { id: string }
type Bound = { type: "arrow" | "text"; id: string }

const INK = "#1e1e1e"
const FRAME_EDGE = "#bbb"
const FONT_FAMILY = 5
const BINDING_GAP = 8

const SHAPES: Record<Exclude<ItemKind, "text" | "heading">, { type: string; roundness: { type: number } | null }> = {
  note: { type: "rectangle", roundness: { type: 3 } },
  rectangle: { type: "rectangle", roundness: { type: 3 } },
  ellipse: { type: "ellipse", roundness: null },
  diamond: { type: "diamond", roundness: { type: 2 } },
}

function element(id: string, type: string, box: Box, rest: Record<string, unknown>): Element {
  return {
    id,
    type,
    ...box,
    angle: 0,
    strokeColor: INK,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: randomInt(2 ** 31),
    version: 1,
    versionNonce: randomInt(2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    ...rest,
  }
}

function text(id: string, original: string, lines: string[], box: Box, size: number, rest: Record<string, unknown>): Element {
  return element(id, "text", box, {
    text: lines.join("\n"),
    originalText: original,
    fontSize: size,
    fontFamily: FONT_FAMILY,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
    ...rest,
  })
}

/** A label's box centred on a point */
function centred(lines: string[], size: number, x: number, y: number): Box {
  const { width, height } = linesSize(lines, size)
  return { x: x - width / 2, y: y - height / 2, width, height }
}

/** Where a line from `from` towards `to` leaves `from`'s edge, the binding gap out */
function edge(from: Box, to: Box): [number, number] {
  const x = from.x + from.width / 2
  const y = from.y + from.height / 2
  const dx = to.x + to.width / 2 - x
  const dy = to.y + to.height / 2 - y
  const length = Math.hypot(dx, dy)
  if (!length) return [x, y]
  const reach = Math.min(dx ? from.width / 2 / Math.abs(dx) : Infinity, dy ? from.height / 2 / Math.abs(dy) : Infinity)
  return [x + dx * reach + (dx / length) * BINDING_GAP, y + dy * reach + (dy / length) * BINDING_GAP]
}

/** Where along an arrow its label is tried, from the middle outwards in steps fine enough to find the gap between two items */
const SLIDE = [0.5, ...Array.from({ length: 49 }, (_, i) => [0.49 - i / 100, 0.51 + i / 100]).flat()]

const bind = (target: Element, bound: Bound) => {
  target.boundElements = [...((target.boundElements as Bound[] | null) ?? []), bound]
}

/** The plan as full Excalidraw elements at the boxes `layoutBoard` gave. A line is an arrow without heads, since only arrows bind. A label sits on the arrow's middle point, slid along it to the first clear spot */
export function boardElements(plan: BoardPlan, placed: Placed, ids: { newId(): string }): Record<string, unknown>[] {
  const frameIds = new Map([...placed.frames.keys()].map((group) => [group, ids.newId()]))
  const framed = new Map([...frameIds.keys()].map((group): [string, Element[]] => [group, []]))
  const loose: Element[] = []
  const anchors = new Map<string, { element: Element; box: Box }>()

  for (const item of plan.items) {
    const box = placed.items.get(item.id)
    if (!box) continue
    const frameId = (item.group !== undefined && frameIds.get(item.group)) || null
    const shapes = (item.group !== undefined && framed.get(item.group)) || loose
    if (item.kind === "text" || item.kind === "heading") {
      const lines = wrap(item.text, TEXT_WIDTH, textSize(item.kind))
      const free = text(ids.newId(), item.text, lines, box, textSize(item.kind), { frameId, autoResize: lines.join("\n") === item.text })
      shapes.push(free)
      anchors.set(item.id, { element: free, box })
      continue
    }
    const colour = BOARD_PALETTE[item.color ?? (item.kind === "note" ? "lemon" : "sky")]
    const { type, roundness } = SHAPES[item.kind]
    const shape = element(ids.newId(), type, box, { backgroundColor: colour.fill, strokeColor: colour.edge, roundness, frameId })
    const lines = shapeLines(item.kind, item.text, box.width)
    const label = text(ids.newId(), item.text, lines, centred(lines, FONT_SIZE, box.x + box.width / 2, box.y + box.height / 2), FONT_SIZE, {
      containerId: shape.id,
      frameId,
      textAlign: "center",
      verticalAlign: "middle",
    })
    bind(shape, { type: "text", id: label.id })
    shapes.push(shape, label)
    anchors.set(item.id, { element: shape, box })
  }

  const titles = plan.groups.flatMap((group) => {
    const box = placed.titles.get(group.id)
    return box && group.title ? [text(ids.newId(), group.title, wrap(group.title, TEXT_WIDTH, HEADING_SIZE), box, HEADING_SIZE, {})] : []
  })

  const frames = plan.groups.flatMap((group) => {
    const box = placed.frames.get(group.id)
    const id = frameIds.get(group.id)
    const frame = box && id ? element(id, "frame", box, { name: group.title ?? null, strokeColor: FRAME_EDGE, strokeWidth: 2 }) : null
    return frame ? [...(framed.get(group.id) ?? []), frame] : []
  })

  const frameBoxes = [...placed.frames.values()]
  const taken = [
    ...placed.items.values(),
    ...placed.titles.values(),
    ...frameBoxes.map((frame) => ({ x: frame.x, y: frame.y - FRAME_TITLE, width: frame.width, height: FRAME_TITLE })),
  ]
  const fits = (box: Box) =>
    taken.every((other) => !overlaps(box, other)) && frameBoxes.every((frame) => within(box, frame) || !overlaps(box, frame))

  const links = plan.connections.flatMap((link) => {
    const from = anchors.get(link.from)
    const to = anchors.get(link.to)
    if (!from || !to) return []
    const [x, y] = edge(from.box, to.box)
    const [endX, endY] = edge(to.box, from.box)
    const lines = link.label ? wrap(link.label, LABEL_WIDTH, LABEL_SIZE) : []
    const at = (t: number) => centred(lines, LABEL_SIZE, x + (endX - x) * t, y + (endY - y) * t)
    const t = link.label ? (SLIDE.find((each) => fits(at(each))) ?? 0.5) : 0.5
    const arrow = element(
      ids.newId(),
      "arrow",
      { x, y, width: Math.abs(endX - x), height: Math.abs(endY - y) },
      {
        points: [[0, 0], ...(link.label ? [[(endX - x) * t, (endY - y) * t]] : []), [endX - x, endY - y]],
        lastCommittedPoint: null,
        startBinding: { elementId: from.element.id, focus: 0, gap: BINDING_GAP },
        endBinding: { elementId: to.element.id, focus: 0, gap: BINDING_GAP },
        startArrowhead: null,
        endArrowhead: link.kind === "arrow" ? "arrow" : null,
        elbowed: false,
        roundness: { type: 2 },
      },
    )
    bind(from.element, { type: "arrow", id: arrow.id })
    bind(to.element, { type: "arrow", id: arrow.id })
    if (!link.label) return [arrow]
    const box = at(t)
    taken.push(box)
    const label = text(ids.newId(), link.label, lines, box, LABEL_SIZE, {
      containerId: arrow.id,
      textAlign: "center",
      verticalAlign: "middle",
    })
    bind(arrow, { type: "text", id: label.id })
    return [arrow, label]
  })

  return [...frames, ...loose, ...titles, ...links]
}
