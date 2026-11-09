// Where each cat scene's parts sit, and the viewBox that holds them with room to spare

/** The logo's size in pixels, so features can be placed on it in its own units */
export const LOGO_W = 552
export const LOGO_H = 510
/** The cutout ring around the cat, in logo pixels */
export const RING = 26
/** The stroke of a scene's outlined objects */
export const LINE_WIDTH = 2.25

// The logo's inner-ear and nose holes, traced from its pixels, to cut back out of the solid silhouette
export const EAR_HOLES =
  "M57 51L65 51L69 53L91 66L118 82L133 91L136 93L138 95L139 97L139 105L138 107L135 110L132 112L99 132L74 147L70 149L67 150L65 150L62 149L60 148L57 145L56 143L55 134L54 114L52 73L52 56L54 53L55 52Z" +
  "M497 132L496 144L494 147L493 148L489 150L483 150L477 147L422 115L417 112L413 108L412 105L412 100L414 96L416 94L442 78L473 59L483 53L485 52L488 51L492 51L496 53L497 54L499 58L499 71L498 102Z"
export const SHUT_EYES = "M106 244Q160 296 214 244M343 244Q397 296 451 244"
/** The nose, painted back over the solid silhouette */
export const NOSE = { cx: 278.5, cy: 353, rx: 43.5, ry: 26 }

type Box = { minX: number; minY: number; maxX: number; maxY: number }
type Placement = { x: number; y: number; width: number; rotate?: number }
export type ViewBox = { x: number; y: number; width: number; height: number }

/** A rectangle's bounds after turning it about a point, grown by pad on each side */
function turnedRect(x: number, y: number, w: number, h: number, degrees: number, about: [number, number], pad = 0): Box {
  const t = (degrees * Math.PI) / 180
  const [cx, cy] = about
  const corners = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ].map(([px, py]) => [cx + (px - cx) * Math.cos(t) - (py - cy) * Math.sin(t), cy + (px - cx) * Math.sin(t) + (py - cy) * Math.cos(t)])
  return {
    minX: Math.min(...corners.map((c) => c[0])) - pad,
    minY: Math.min(...corners.map((c) => c[1])) - pad,
    maxX: Math.max(...corners.map((c) => c[0])) + pad,
    maxY: Math.max(...corners.map((c) => c[1])) + pad,
  }
}

const rect = (minX: number, minY: number, maxX: number, maxY: number, pad = 0): Box => ({
  minX: minX - pad,
  minY: minY - pad,
  maxX: maxX + pad,
  maxY: maxY + pad,
})

/** The cat's logo box, turned about its centre, with the cutout ring when it has one */
export function catBox({ x, y, width, rotate = 0 }: Placement, ring: boolean): Box {
  const height = (width * LOGO_H) / LOGO_W
  const pad = ring ? (RING * width) / LOGO_W : 0
  return turnedRect(x, y, width, height, rotate, [x + width / 2, y + height / 2], pad)
}

/** A "z" set at a baseline, with room for its outline */
const zBox = (x: number, baseline: number, size: number, stroke = 0): Box =>
  rect(x, baseline - 0.62 * size, x + 0.62 * size, baseline + 0.04 * size, stroke / 2)

function union(...boxes: Box[]): Box {
  return {
    minX: Math.min(...boxes.map((b) => b.minX)),
    minY: Math.min(...boxes.map((b) => b.minY)),
    maxX: Math.max(...boxes.map((b) => b.maxX)),
    maxY: Math.max(...boxes.map((b) => b.maxY)),
  }
}

/** The content with a margin on each side as a share of its size, or a centred square */
function fit(content: Box, margin: number, square = false): ViewBox {
  const w = content.maxX - content.minX
  const h = content.maxY - content.minY
  const cx = (content.minX + content.maxX) / 2
  const cy = (content.minY + content.maxY) / 2
  const width = square ? Math.max(w, h) * (1 + 2 * margin) : w * (1 + 2 * margin)
  const height = square ? width : h * (1 + 2 * margin)
  return { x: cx - width / 2, y: cy - height / 2, width, height }
}

export const viewBoxOf = (v: ViewBox) => `${v.x} ${v.y} ${v.width} ${v.height}`

export const SCENE_MARGIN = 0.1

export const TRASH = {
  cat: { x: 37, y: 19, width: 46, rotate: -6 },
  lid: { x: 57.4, y: 20.5, rotate: -5.8 },
}
const trashContent = union(
  catBox(TRASH.cat, true),
  rect(31, 46, 89, 91, LINE_WIDTH / 2),
  turnedRect(TRASH.lid.x - 28, TRASH.lid.y - 14, 56, 17, TRASH.lid.rotate, [TRASH.lid.x, TRASH.lid.y], LINE_WIDTH / 2),
)

export const FOLDER = {
  cat: { x: 33, y: 29, width: 42 },
  tail: "M100 73C108 73 113 69 113.5 61.5C113.8 56.5 110.5 54.5 108 56.5",
}
const folderContent = union(catBox(FOLDER.cat, true), rect(11.1, 24, 108.9, 88, LINE_WIDTH / 2), rect(100, 54.5, 113.8, 73, 7.5 / 2))

export const NAPPING = {
  cat: { x: 32, y: 34, width: 56, rotate: -8 },
  z: [
    { x: 86, y: 37, size: 19, stroke: 3 },
    { x: 98, y: 24, size: 14, stroke: 2.6 },
  ],
}
const nappingContent = union(catBox(NAPPING.cat, true), ...NAPPING.z.map((z) => zBox(z.x, z.y, z.size, z.stroke)))

const searchCat = { x: 28, y: 30, width: 52 }
const scale = searchCat.width / LOGO_W
export const SEARCHING = {
  cat: searchCat,
  eye: { x: searchCat.x + 397 * scale, y: searchCat.y + 250 * scale },
  r: 14,
}
const { eye, r } = SEARCHING
const searchingContent = union(
  catBox(searchCat, true),
  rect(eye.x - r, eye.y - r, eye.x + r, eye.y + r, 6.5 / 2),
  turnedRect(eye.x + 10 - 4.5, eye.y + 10, 9, 18, -45, [eye.x + 10, eye.y + 10], LINE_WIDTH / 2),
)

/**
 * Reaction icons frame the cat as the logo image fills a square box, so they match Purr in size.
 * The outline and the gap that parts the extras from the cat are in logo pixels. Extras' bounds are what shows.
 */
const reactionHandle = { width: 54, length: 74 }
export const REACTION = {
  view: fit(rect(0, 0, LOGO_W, LOGO_H), 0, true),
  outline: 26,
  gap: 24,
  z: { x: 300, y: 92, size: 165 },
  lens: { eye: { x: 397, y: 250 }, r: 80, handle: reactionHandle },
}
const { outline, z: rz, lens } = REACTION
const reactionLens = lens.r + outline / 2
const handleStart = (lens.r - outline) * Math.SQRT1_2
export const REACTION_EXTRAS = {
  sleepy: zBox(rz.x, rz.y, rz.size, 2 * outline),
  searching: union(
    rect(lens.eye.x - reactionLens, lens.eye.y - reactionLens, lens.eye.x + reactionLens, lens.eye.y + reactionLens),
    turnedRect(
      lens.eye.x + handleStart - reactionHandle.width / 2,
      lens.eye.y + handleStart,
      reactionHandle.width,
      reactionHandle.length,
      -45,
      [lens.eye.x + handleStart, lens.eye.y + handleStart],
      outline / 2,
    ),
  ),
}

/** Each scene's drawn bounds and the viewBox it is shown in */
export const LAYOUT = {
  trash: { content: trashContent, view: fit(trashContent, SCENE_MARGIN) },
  folder: { content: folderContent, view: fit(folderContent, SCENE_MARGIN) },
  napping: { content: nappingContent, view: fit(nappingContent, SCENE_MARGIN) },
  searching: { content: searchingContent, view: fit(searchingContent, SCENE_MARGIN) },
}
