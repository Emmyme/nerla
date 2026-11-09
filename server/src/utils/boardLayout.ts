import type { PaletteName } from "./boardElements"

export type ItemKind = "note" | "text" | "heading" | "rectangle" | "ellipse" | "diamond"
export type PlanItem = { id: string; kind: ItemKind; text: string; color?: PaletteName; group?: string }
export type PlanGroup = { id: string; title?: string; frame?: boolean }
export type PlanLink = { from: string; to: string; kind: "arrow" | "line"; label?: string }
export type BoardPlan = {
  items: PlanItem[]
  groups: PlanGroup[]
  connections: PlanLink[]
  layout: "clusters" | "mind_map" | "columns" | "flow"
  center?: string
}
export type Box = { x: number; y: number; width: number; height: number }
/** Boxes by item id, and frames and unframed group titles by group id */
export type Placed = { items: Map<string, Box>; frames: Map<string, Box>; titles: Map<string, Box> }

const BOARD_MAX_ITEMS = 60
const BOARD_MAX_LINKS = 80
const BOARD_MAX_GROUPS = 12
const ITEM_MAX = 280
const TITLE_MAX = 80
const LABEL_MAX = 60
const BOARD_CAPS = `A board call can place at most ${BOARD_MAX_ITEMS} items, ${BOARD_MAX_LINKS} connections and ${BOARD_MAX_GROUPS} groups`

export const FONT_SIZE = 20
export const HEADING_SIZE = 28
export const LABEL_SIZE = 16
export const LINE_HEIGHT = 1.25
export const TEXT_WIDTH = 400
export const LABEL_WIDTH = 120
const CHAR = 0.6
const PAD = 24
/** Excalidraw's own padding for text inside an ellipse or a diamond */
const BOUND_PAD = 5
const NOTE_SIDE = 200
const SHAPE_WIDTH = 200
const SHAPE_HEIGHT = 120
const SHAPE_MAX_WIDTH = 400
const GAP = 40
const GROUP_GAP = 120
const FRAME_PAD = 40
/** Excalidraw draws a frame's name just above it */
export const FRAME_TITLE = 32
const BESIDE = 160
const LABEL_ROOM = 8
const CLUSTER_COLUMNS = 3
const CLUSTERS_PER_ROW = 4
const MIND_MAP_COLUMNS = 2
const FLOW_PER_ROW = 6
const RING_STEP = 10

export function checkPlan(plan: BoardPlan): string | null {
  if (plan.items.length > BOARD_MAX_ITEMS || plan.connections.length > BOARD_MAX_LINKS || plan.groups.length > BOARD_MAX_GROUPS)
    return BOARD_CAPS
  if (!plan.items.length) return "A board call needs at least one item"
  const groups = new Set<string>()
  for (const group of plan.groups) {
    if (groups.has(group.id)) return `The group id ${group.id} is used twice`
    groups.add(group.id)
    if ((group.title?.length ?? 0) > TITLE_MAX) return `A group title can have at most ${TITLE_MAX} characters`
  }
  const items = new Set<string>()
  for (const item of plan.items) {
    if (items.has(item.id)) return `The item id ${item.id} is used twice`
    items.add(item.id)
    if (item.kind === "heading" && item.text.length > TITLE_MAX) return `A heading can have at most ${TITLE_MAX} characters`
    if (item.text.length > ITEM_MAX) return `An item can have at most ${ITEM_MAX} characters`
    if (item.group !== undefined && !groups.has(item.group)) return `Item ${item.id} names the group ${item.group}, which isn't in groups`
  }
  for (const link of plan.connections) {
    const unknown = [link.from, link.to].find((id) => !items.has(id))
    if (unknown !== undefined) return `A connection names ${unknown}, which isn't one of the items`
    if (link.from === link.to) return `A connection can't join ${link.from} to itself`
    if ((link.label?.length ?? 0) > LABEL_MAX) return `A connection label can have at most ${LABEL_MAX} characters`
  }
  if (plan.layout === "mind_map") {
    if (plan.center === undefined) return "A mind map needs a center, the id of the item in the middle"
    const center = plan.items.find((item) => item.id === plan.center)
    if (!center) return `The center ${plan.center} isn't one of the items`
    if (center.group !== undefined) return "The center can't be in a group"
  }
  return null
}

/** Breaks text into lines of at most `width` at `size`. A longer word keeps a line of its own up to `words` wide, and only a word past that is split */
export function wrap(text: string, width: number, size: number, words = width): string[] {
  const max = Math.max(1, Math.floor(width / (size * CHAR)))
  const whole = Math.max(max, Math.floor(words / (size * CHAR)))
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    let line = ""
    for (const word of paragraph.split(" ")) {
      let rest = word
      while (rest.length > whole) {
        if (line) lines.push(line)
        line = ""
        lines.push(rest.slice(0, whole))
        rest = rest.slice(whole)
      }
      if (rest.length > max) {
        if (line) lines.push(line)
        line = rest
      } else if (!line) line = rest
      else if (line.length + 1 + rest.length <= max) line += ` ${rest}`
      else {
        lines.push(line)
        line = rest
      }
    }
    lines.push(line)
  }
  return lines
}

/** The size of these lines of text, as Excalidraw's text box at `size` */
export function linesSize(lines: string[], size: number) {
  return { width: Math.max(1, ...lines.map((line) => line.length)) * size * CHAR, height: lines.length * size * LINE_HEIGHT }
}

/** How wide a label inside a shape may run */
function labelWidth(kind: ItemKind, width: number): number {
  if (kind === "ellipse") return Math.round(width * Math.SQRT1_2) - 2 * BOUND_PAD
  if (kind === "diamond") return Math.round(width / 2) - 2 * BOUND_PAD
  return width - 2 * PAD
}

export const textSize = (kind: ItemKind) => (kind === "heading" ? HEADING_SIZE : FONT_SIZE)

/** A shape's label lines. In a note or rectangle a word stays whole up to Excalidraw's own text width, as Excalidraw keeps it */
export function shapeLines(kind: ItemKind, text: string, width: number): string[] {
  const words = kind === "note" || kind === "rectangle" ? width - 2 * BOUND_PAD : undefined
  return wrap(text, labelWidth(kind, width), FONT_SIZE, words)
}

/** An ellipse or diamond widens until its longest word fits on a line */
function shapeWidth(item: Pick<PlanItem, "kind" | "text">) {
  if (item.kind !== "ellipse" && item.kind !== "diamond") return item.kind === "note" ? NOTE_SIDE : SHAPE_WIDTH
  const word = Math.max(0, ...item.text.split(/\s/).map((each) => each.length)) * FONT_SIZE * CHAR + 2 * BOUND_PAD
  const width = Math.ceil(item.kind === "ellipse" ? word / Math.SQRT1_2 : word * 2) + 2
  return Math.min(SHAPE_MAX_WIDTH, Math.max(SHAPE_WIDTH, width))
}

function itemSize(item: Pick<PlanItem, "kind" | "text">) {
  if (item.kind === "text" || item.kind === "heading")
    return linesSize(wrap(item.text, TEXT_WIDTH, textSize(item.kind)), textSize(item.kind))
  const width = shapeWidth(item)
  const text = shapeLines(item.kind, item.text, width).length * FONT_SIZE * LINE_HEIGHT
  const needed =
    item.kind === "ellipse"
      ? Math.ceil((text + 2 * BOUND_PAD) / Math.SQRT1_2) + 1
      : item.kind === "diamond"
        ? 2 * (text + 2 * BOUND_PAD)
        : text + 2 * PAD
  return { width, height: Math.max(item.kind === "note" ? NOTE_SIDE : SHAPE_HEIGHT, needed) }
}

type Piece = { map: keyof Placed; id: string; box: Box }
type Block = { width: number; height: number; pieces: Piece[]; count: number; grouped: boolean }
type Spacing = { x: number; y: number; group: number }

const move = (pieces: Piece[], dx: number, dy: number): Piece[] =>
  pieces.map((piece) => ({ ...piece, box: { ...piece.box, x: piece.box.x + dx, y: piece.box.y + dy } }))

const offsets = (sizes: number[], gap: number) => sizes.map((_, i) => sizes.slice(0, i).reduce((sum, size) => sum + size + gap, 0))
const total = (sizes: number[], gap: number) => sizes.reduce((sum, size) => sum + size, 0) + gap * Math.max(0, sizes.length - 1)

function grid(items: PlanItem[], columns: number, gap: Spacing, middle: boolean): Block {
  const sizes = items.map(itemSize)
  const widths: number[] = []
  const heights: number[] = []
  sizes.forEach((size, i) => {
    const column = i % columns
    const row = Math.floor(i / columns)
    widths[column] = Math.max(widths[column] ?? 0, size.width)
    heights[row] = Math.max(heights[row] ?? 0, size.height)
  })
  const xs = offsets(widths, gap.x)
  const ys = offsets(heights, gap.y)
  const pieces = items.map((item, i): Piece => {
    const row = Math.floor(i / columns)
    const lift = middle ? (heights[row] - sizes[i].height) / 2 : 0
    return { map: "items", id: item.id, box: { x: xs[i % columns], y: ys[row] + lift, ...sizes[i] } }
  })
  return { width: total(widths, gap.x), height: total(heights, gap.y), pieces, count: items.length, grouped: false }
}

/** A group's frame, or its title as a heading above its items */
function dress(block: Block, group: PlanGroup | undefined, gap: Spacing): Block {
  if (!group) return block
  if (group.frame) {
    const frame = { x: 0, y: FRAME_TITLE, width: block.width + 2 * FRAME_PAD, height: block.height + 2 * FRAME_PAD }
    const pieces = [...move(block.pieces, FRAME_PAD, FRAME_TITLE + FRAME_PAD), { map: "frames" as const, id: group.id, box: frame }]
    return { ...block, width: frame.width, height: FRAME_TITLE + frame.height, pieces }
  }
  if (!group.title) return block
  const title = itemSize({ kind: "heading", text: group.title })
  const pieces = [{ map: "titles" as const, id: group.id, box: { x: 0, y: 0, ...title } }, ...move(block.pieces, 0, title.height + gap.y)]
  return { ...block, width: Math.max(block.width, title.width), height: title.height + gap.y + block.height, pieces }
}

/** Lines of blocks left to right, each line below the last */
function stack(lines: Block[][], gap: Spacing, middle: boolean): Block {
  const pieces: Piece[] = []
  let y = 0
  let width = 0
  lines.forEach((line, i) => {
    if (i > 0) y += lines[i - 1].some((block) => block.grouped) || line.some((block) => block.grouped) ? gap.group : gap.y
    const height = Math.max(...line.map((block) => block.height))
    let x = 0
    line.forEach((block, j) => {
      if (j > 0) x += block.grouped || line[j - 1].grouped ? gap.group : gap.x
      pieces.push(...move(block.pieces, x, y + (middle ? (height - block.height) / 2 : 0)))
      x += block.width
    })
    width = Math.max(width, x)
    y += height
  })
  return { width, height: y, pieces, count: 0, grouped: true }
}

const chunks = <T>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

/** Separate by at least `gap`, so touching counts as apart */
const apart = (a: Box, b: Box, gap: number) =>
  a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x || a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y

export const overlaps = (a: Box, b: Box) => !apart(a, b, 0)
export const within = (inner: Box, outer: Box) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

function ring(center: Block, units: Block[], gap: Spacing): Block {
  const placed: { box: Box; block: Block }[] = [
    { box: { x: -center.width / 2, y: -center.height / 2, width: center.width, height: center.height }, block: center },
  ]
  units.forEach((unit, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / units.length
    for (let radius = 0; ; radius += RING_STEP) {
      const box = {
        x: radius * Math.cos(angle) - unit.width / 2,
        y: radius * Math.sin(angle) - unit.height / 2,
        width: unit.width,
        height: unit.height,
      }
      const clear = placed.every((other) => apart(box, other.box, unit.grouped || other.block.grouped ? gap.group : Math.max(gap.x, gap.y)))
      if (clear) {
        placed.push({ box, block: unit })
        break
      }
    }
  })
  const left = Math.min(...placed.map(({ box }) => box.x))
  const top = Math.min(...placed.map(({ box }) => box.y))
  const pieces = placed.flatMap(({ box, block }) => move(block.pieces, box.x - left, box.y - top))
  const width = Math.max(...placed.map(({ box }) => box.x + box.width)) - left
  const height = Math.max(...placed.map(({ box }) => box.y + box.height)) - top
  return { width, height, pieces, count: 0, grouped: true }
}

/** Gaps wide enough for the widest connection label to sit between two neighbours */
function spacing(plan: BoardPlan): Spacing {
  const labels = plan.connections.flatMap((link) => (link.label ? [linesSize(wrap(link.label, LABEL_WIDTH, LABEL_SIZE), LABEL_SIZE)] : []))
  const x = Math.max(GAP, ...labels.map((label) => label.width + 2 * LABEL_ROOM))
  const y = Math.max(GAP, ...labels.map((label) => label.height + 2 * LABEL_ROOM))
  return { x, y, group: Math.max(GROUP_GAP, x, y) }
}

function arrange(plan: BoardPlan, gap: Spacing): Block {
  const center = plan.layout === "mind_map" ? plan.center : undefined
  const items = plan.items.filter((item) => item.id !== center)
  const grouped = new Set(plan.groups.map((group) => group.id))
  const loose = items.filter((item) => item.group === undefined || !grouped.has(item.group))
  const membersOf = (group: PlanGroup) => items.filter((item) => item.group === group.id)
  const groupBlocks = (columns: number, middle = false) =>
    plan.groups
      .map((group) => ({ group, members: membersOf(group) }))
      .filter(({ members }) => members.length)
      .map(({ group, members }) => ({ ...dress(grid(members, columns, gap, middle), group, gap), grouped: true }))
  const looseBlock = (columns: number) => (loose.length ? [{ ...grid(loose, columns, gap, false), grouped: true }] : [])

  if (plan.layout === "clusters")
    return stack(chunks([...groupBlocks(CLUSTER_COLUMNS), ...looseBlock(CLUSTER_COLUMNS)], CLUSTERS_PER_ROW), gap, false)
  if (plan.layout === "columns") return stack([[...groupBlocks(1), ...looseBlock(1)]], gap, false)
  if (plan.layout === "mind_map") {
    const hub = plan.items.find((item) => item.id === center)!
    const singles = loose.map((item) => grid([item], 1, gap, false))
    return ring({ ...grid([hub], 1, gap, false), grouped: true }, [...groupBlocks(MIND_MAP_COLUMNS), ...singles], gap)
  }
  const blocks = new Map(plan.groups.map((group) => [group.id, group]))
  const units: Block[] = []
  const done = new Set<string>()
  for (const item of items) {
    const group = item.group === undefined ? undefined : blocks.get(item.group)
    if (!group) units.push(grid([item], 1, gap, false))
    else if (!done.has(group.id)) {
      done.add(group.id)
      units.push({ ...dress(grid(membersOf(group), FLOW_PER_ROW, gap, true), group, gap), grouped: true })
    }
  }
  const lines: Block[][] = []
  for (const unit of units) {
    const line = lines.at(-1)
    if (line && line.reduce((sum, block) => sum + block.count, 0) + unit.count <= FLOW_PER_ROW) line.push(unit)
    else lines.push([unit])
  }
  return stack(lines, gap, true)
}

/** Where each item, frame and group title goes. New content sits right of `existing`, top aligned, so nothing there moves */
export function layoutBoard(plan: BoardPlan, existing: Box[]): Placed {
  const x = existing.length ? Math.max(...existing.map((box) => box.x + box.width)) + BESIDE : 0
  const y = existing.length ? Math.min(...existing.map((box) => box.y)) : 0
  const placed: Placed = { items: new Map(), frames: new Map(), titles: new Map() }
  for (const piece of move(arrange(plan, spacing(plan)).pieces, x, y)) placed[piece.map].set(piece.id, piece.box)
  return placed
}
