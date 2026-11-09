import { createHash, randomUUID } from "node:crypto"
import * as Y from "yjs"
import {
  docSpecs,
  docToText,
  elements,
  formatRefusal,
  heldRefs,
  NO_REFS,
  parseDocText,
  toY,
  unitsOf,
  unitSupported,
  unitText,
  type Kept,
  type Resolved,
  type Spec,
  type Unit,
} from "./docFormat"
import { BOARD_PALETTE } from "./boardElements"
import { HEADING_SIZE, type Box } from "./boardLayout"
import { PAPER_BOARDS_FIELD, TEXT_FIELD } from "./docYjs"

export { lineText } from "./docFormat"

export type DocWrite =
  | { op: "append"; text: string; revision: string }
  | { op: "insert_after"; ref: string; text: string; revision: string }
  | { op: "replace"; from: string; to: string; text: string; revision: string }

export type WriteResult = { ok: true } | { ok: false; error: string }

type DocWriteResult = { ok: true; kept: Kept[] } | { ok: false; error: string }

export const STALE = { ok: false as const, error: "The paper changed, read it again" }

/** The first 12 hex characters of the sha1 of the doc's snapshot, which deletions change too */
export function revisionOf(doc: Y.Doc): string {
  return createHash("sha1")
    .update(Y.encodeSnapshot(Y.snapshot(doc)))
    .digest("hex")
    .slice(0, 12)
}

/** The unit a `b{n}` ref points at, or -1 */
function unitIndex(units: Unit[], ref: string): number {
  const match = /^b(\d+)$/.exec(ref.trim())
  const index = match ? Number(match[1]) : -1
  return index >= 0 && index < units.length ? index : -1
}

/** A paper as one `[b{n}] {text}` line per block in the paper format, and its revision */
export function docBlocks(doc: Y.Doc, hidden?: ReadonlySet<string>): { text: string; revision: string } {
  return {
    text: docToText(doc, hidden)
      .map((text, i) => `[b${i}] ${text}`)
      .join("\n"),
    revision: revisionOf(doc),
  }
}

/** The tasks the paper's checklist lines show, with the title each line holds */
export const docTasks = (doc: Y.Doc): ReadonlyMap<string, { title: string }> => heldRefs(unitsOf(doc)).tasks

/** One unit's text, without its ref */
export const unitTextAt = (doc: Y.Doc, ref: string): { unit: Unit; text: string } | null => {
  const units = unitsOf(doc)
  const index = unitIndex(units, ref)
  return index < 0 ? null : { unit: units[index], text: unitText(units[index]) }
}

const newIds = { newId: () => randomUUID() }

/** Attributes keep their own type, as the editor stores them: a checked line's `checked` is a boolean */
const setAttr = (node: Y.XmlElement, key: string, value: unknown) => node.setAttribute(key, value as string)

function copyList(list: Y.XmlElement, items: Y.XmlElement[], start: number | null): Y.XmlElement {
  const copy = new Y.XmlElement(list.nodeName)
  for (const [key, value] of Object.entries(list.getAttributes())) if (value !== undefined) setAttr(copy, key, value)
  if (start !== null) setAttr(copy, "start", start)
  copy.insert(
    0,
    items.map((item) => item.clone() as Y.XmlElement),
  )
  return copy
}

const startOf = (list: Y.XmlElement) => Number(list.getAttribute("start")) || 1

/** Moves the list's items from `at` on into a list of their own just after it */
function splitAfter(fragment: Y.XmlFragment, list: Y.XmlElement, at: number) {
  const items = elements(list)
  if (at <= 0 || at >= items.length) return
  const tail = copyList(list, items.slice(at), list.nodeName === "orderedList" ? startOf(list) + at : null)
  list.delete(at, items.length - at)
  fragment.insert(fragment.toArray().indexOf(list) + 1, [tail])
}

/** Moves the list's items before `at` into a list of their own just before it */
function splitBefore(fragment: Y.XmlFragment, list: Y.XmlElement, at: number) {
  const items = elements(list)
  if (at <= 0 || at >= items.length) return
  const head = copyList(list, items.slice(0, at), null)
  if (list.nodeName === "orderedList") setAttr(list, "start", startOf(list) + at)
  list.delete(0, at)
  fragment.insert(fragment.toArray().indexOf(list), [head])
}

/** Removes units `start` to `end` (exclusive) and puts the blocks where they were */
function splice(doc: Y.Doc, units: Unit[], start: number, end: number, blocks: Spec[]) {
  const fragment = doc.getXmlFragment(TEXT_FIELD)
  const range = units.slice(start, end)
  const before = units[start - 1] ?? null
  const list = range.length
    ? range.every((unit) => unit.item && unit.block === range[0].block)
      ? range[0].block
      : null
    : (before?.item && before.block) || null

  // Lines of the same kind of list go into the list itself
  if (list && (blocks.length ? blocks.every((block) => block.name === list.nodeName) : range.length > 0)) {
    const at = range.length ? elements(list).indexOf(range[0].item!) : elements(list).indexOf(before!.item!) + 1
    if (range.length) list.delete(at, range.length)
    const items = blocks.flatMap((block) => (block.children ?? []) as Spec[]).map(toY)
    if (items.length) list.insert(at, items)
    if (list.length === 0) fragment.delete(fragment.toArray().indexOf(list), 1)
    return
  }

  if (range.length) {
    const first = range[0]
    const last = range[range.length - 1]
    if (last.item) splitAfter(fragment, last.block, elements(last.block).indexOf(last.item) + 1)
    if (first.item) splitBefore(fragment, first.block, elements(first.block).indexOf(first.item))
    const from = fragment.toArray().indexOf(first.block)
    fragment.delete(from, fragment.toArray().indexOf(last.block) - from + 1)
    if (blocks.length) fragment.insert(from, blocks.map(toY))
    return
  }
  if (before?.item) splitAfter(fragment, before.block, elements(before.block).indexOf(before.item) + 1)
  const at = before ? fragment.toArray().indexOf(before.block) + 1 : fragment.length
  fragment.insert(at, blocks.map(toY))
}

/** The ids of the boards drawn in a block */
function boardsIn(node: Y.XmlElement): string[] {
  const own = node.nodeName === "boardBlock" ? [String(node.getAttribute("boardId"))] : []
  return [...own, ...elements(node).flatMap(boardsIn)]
}

/** Boards drawn in the paper that no block outside the range shows, so the range may show them again */
function freeBoards(doc: Y.Doc, units: Unit[], start: number, end: number): Set<string> {
  const free = new Set<string>()
  for (const [boardId, board] of doc.getMap<unknown>(PAPER_BOARDS_FIELD).entries()) if (board instanceof Y.Map) free.add(boardId)
  units.forEach((unit, index) => {
    if (index < start || index >= end) for (const boardId of boardsIn(unit.item ?? unit.block)) free.delete(boardId)
  })
  return free
}

type Plan = { units: Unit[]; start: number; end: number; blocks: Spec[]; boards: { boardId: string }[]; kept: Kept[] }

function planDocWrite(doc: Y.Doc, write: DocWrite, resolved: Resolved, ids: { newId(): string }): Plan | { ok: false; error: string } {
  if (revisionOf(doc) !== write.revision) return STALE
  const { nodes } = parseDocText(write.text)
  if (nodes.length === 0 && write.op !== "replace") return { ok: false, error: "There is nothing to write" }
  const refused = formatRefusal(nodes)
  if (refused) return { ok: false, error: refused }
  const units = unitsOf(doc)
  let start = units.length
  let end = units.length
  if (write.op === "insert_after") {
    const at = unitIndex(units, write.ref)
    if (at < 0) return { ok: false, error: `There is no block ${write.ref}` }
    start = end = at + 1
  } else if (write.op === "replace") {
    start = unitIndex(units, write.from)
    const to = unitIndex(units, write.to)
    if (start < 0 || to < 0) return { ok: false, error: `There is no block ${start < 0 ? write.from : write.to}` }
    if (to < start) return { ok: false, error: "The range ends before it starts" }
    // Empty lines don't count, so a blank last line can't make a range that covers every real block
    const filled = units.flatMap((unit, index) => (unitText(unit).trim() ? [index] : []))
    const whole = filled.length > 1 && filled.every((index) => index >= start && index <= to)
    if (whole || (start === 0 && to === units.length - 1 && units.length > 1)) {
      return {
        ok: false,
        error: "A replace can't cover the whole paper. Replace a smaller range, and insert or append around the blocks that stay",
      }
    }
    const held = units.slice(start, to + 1).findIndex((unit) => !unitSupported(unit))
    if (held >= 0) return { ok: false, error: `b${start + held} holds something you can't rewrite. Leave it out of the range` }
    end = to + 1
  }
  // What the range already holds stays, even where the asker can't open it now, and what they can open wins
  const held = heldRefs(units.slice(start, end))
  const merged: Resolved = {
    people: new Map([...held.people, ...resolved.people]),
    tasks: new Map([...held.tasks, ...resolved.tasks]),
    links: new Map([...held.links, ...resolved.links]),
    hrefs: new Map([...held.hrefs, ...resolved.hrefs]),
    images: new Map([...held.images, ...resolved.images]),
    boards: new Set([...held.boards, ...resolved.boards]),
    drawn: freeBoards(doc, units, start, end),
  }
  const built = docSpecs(nodes, merged, ids)
  const shown = new Set<string>()
  const walk = (spec: Spec) => {
    if (spec.name === "boardBlock") shown.add(String(spec.attrs?.boardId))
    for (const child of spec.children ?? []) if ("name" in child) walk(child)
  }
  built.specs.forEach(walk)
  const left = units
    .slice(start, end)
    .flatMap((unit, index) => boardsIn(unit.item ?? unit.block).map((boardId) => ({ boardId, ref: `b${start + index}` })))
  const taken = left
    .filter(({ boardId }) => !shown.has(boardId))
    .map(({ boardId, ref }) => ({
      line: null,
      reason: `The board drawn in ${ref} was taken out of the paper. Its drawing is kept, and a line of ![board](drawn:${boardId}) puts it back`,
    }))
  return { units, start, end, blocks: built.specs, boards: built.boards, kept: [...taken, ...built.kept] }
}

/** Whether the write would apply, without changing anything */
export function checkDocWrite(doc: Y.Doc, write: DocWrite): WriteResult {
  const plan = planDocWrite(doc, write, NO_REFS, newIds)
  return "units" in plan ? { ok: true } : plan
}

/**
 * One write to a paper, as one change, refused when the paper changed since the revision was read. What doesn't
 * resolve stays as the text written and is listed in `kept`, and a new board gets its entry in the doc's boards
 */
export function applyDocWrite(doc: Y.Doc, write: DocWrite, resolved: Resolved = NO_REFS, ids = newIds): DocWriteResult {
  const plan = planDocWrite(doc, write, resolved, ids)
  if (!("units" in plan)) return plan
  doc.transact(() => {
    const boards = doc.getMap<unknown>(PAPER_BOARDS_FIELD)
    for (const { boardId } of plan.boards) if (!boards.has(boardId)) boards.set(boardId, new Y.Map<unknown>())
    splice(doc, plan.units, plan.start, plan.end, plan.blocks)
  })
  return { ok: true, kept: plan.kept }
}

/** Whether the list line is still in the paper */
export const lineIsThere = (doc: Y.Doc, item: Y.XmlElement): boolean => unitsOf(doc).some((unit) => unit.item === item)

type BoardElement = {
  id?: unknown
  type?: unknown
  text?: unknown
  originalText?: unknown
  name?: unknown
  isDeleted?: unknown
  x?: unknown
  y?: unknown
  width?: unknown
  height?: unknown
  containerId?: unknown
  backgroundColor?: unknown
  fontSize?: unknown
  startBinding?: { elementId?: unknown } | null
  endBinding?: { elementId?: unknown } | null
}

const live = (value: unknown): value is BoardElement =>
  !!value && typeof value === "object" && !(value instanceof Y.AbstractType) && (value as BoardElement).isDeleted !== true

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

const liveElements = (map: Y.Map<unknown>) => [...map.values()].filter(live)

/** Where everything on the board sits, so new content goes beside it */
export const boardBoxes = (map: Y.Map<unknown>): Box[] =>
  liveElements(map).map((element) => ({
    x: num(element.x),
    y: num(element.y),
    width: Math.max(num(element.width), 0),
    height: Math.max(num(element.height), 0),
  }))

const COLOURS = new Map<string, string>(Object.entries(BOARD_PALETTE).map(([name, colour]) => [colour.fill.toLowerCase(), name]))
/** A sticky note is a 200 wide palette rectangle at least as tall */
const NOTE_SIDE = 200

function kindOf(element: BoardElement, colour: string | undefined): string {
  if (element.type === "text") return num(element.fontSize) >= HEADING_SIZE ? "heading" : "text"
  if (element.type === "rectangle")
    return colour && num(element.width) === NOTE_SIDE && num(element.height) >= NOTE_SIDE ? "note" : "rectangle"
  if (element.type === "freedraw") return "drawing"
  return typeof element.type === "string" ? element.type : "element"
}

const said = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "")

/**
 * A board as one `[e{n}] {kind} {colour} "{text}"` line per element, top to bottom. A label inside a shape or on an
 * arrow is part of it, a frame shows its name, and an arrow or line names the elements it joins
 */
export function boardLines(map: Y.Map<unknown>): string {
  const elements = liveElements(map)
  const ids = new Set(elements.map((element) => element.id))
  const labels = new Map<unknown, string>()
  for (const element of elements) {
    if (element.type === "text" && ids.has(element.containerId)) labels.set(element.containerId, said(element.originalText ?? element.text))
  }
  const shown = elements
    .filter((element) => !(element.type === "text" && ids.has(element.containerId)))
    .sort((a, b) => num(a.y) - num(b.y) || num(a.x) - num(b.x))
  const refs = new Map(shown.map((element, i) => [element.id, `e${i}`]))
  return shown
    .map((element, i) => {
      const colour = typeof element.backgroundColor === "string" ? COLOURS.get(element.backgroundColor.toLowerCase()) : undefined
      const kind = kindOf(element, colour)
      const text =
        element.type === "frame"
          ? said(element.name)
          : element.type === "text"
            ? said(element.originalText ?? element.text)
            : (labels.get(element.id) ?? "")
      const ends =
        element.type === "arrow" || element.type === "line"
          ? [element.startBinding?.elementId, element.endBinding?.elementId].map((id) => refs.get(id) ?? "nothing")
          : null
      return [`[e${i}] ${kind}`, ends && `${ends[0]} to ${ends[1]}`, kind !== "frame" && colour, text && JSON.stringify(text)]
        .filter(Boolean)
        .join(" ")
    })
    .join("\n")
}
