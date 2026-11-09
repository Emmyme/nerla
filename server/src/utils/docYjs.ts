import { randomInt } from "node:crypto"
import * as Y from "yjs"
import { UUID } from "./uuid"

/** A paper's text */
export const TEXT_FIELD = "default"
/** Boards inside a paper, one map of elements per board block id */
export const PAPER_BOARDS_FIELD = "boards"
/** A board file's elements */
export const BOARD_FIELD = "board"

/** The users mentioned in a paper's text, each once */
export function mentionIdsIn(doc: Y.Doc): string[] {
  const ids = new Set<string>()
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue
      if (child.nodeName === "mention") {
        const id = child.getAttribute("id")
        if (typeof id === "string" && UUID.test(id)) ids.add(id.toLowerCase())
      }
      walk(child)
    }
  }
  walk(doc.getXmlFragment(TEXT_FIELD))
  return [...ids]
}

const imageOf = (value: unknown): string | null => {
  const element = value as { type?: unknown; fileId?: unknown } | null
  return element && typeof element === "object" && element.type === "image" && typeof element.fileId === "string" ? element.fileId : null
}

/** Every board map in the doc: a board file's own, and each board inside a paper */
function boardMaps(doc: Y.Doc): Y.Map<unknown>[] {
  const inside = [...doc.getMap<unknown>(PAPER_BOARDS_FIELD).values()].filter((board): board is Y.Map<unknown> => board instanceof Y.Map)
  return [doc.getMap<unknown>(BOARD_FIELD), ...inside]
}

function paperImages(doc: Y.Doc): Y.XmlElement[] {
  const found: Y.XmlElement[] = []
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue
      if (child.nodeName === "image") found.push(child)
      walk(child)
    }
  }
  walk(doc.getXmlFragment(TEXT_FIELD))
  return found
}

/** The file ids of the pictures a paper's text and its boards show, each once */
export function imageIdsIn(doc: Y.Doc): string[] {
  const ids = new Set<string>()
  for (const image of paperImages(doc)) {
    const id = image.getAttribute("fileId")
    if (typeof id === "string") ids.add(id)
  }
  for (const board of boardMaps(doc)) {
    for (const element of board.values()) {
      const id = imageOf(element)
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

/** Points the doc's pictures at other files, as a copy does with copies of its images */
export function swapImages(doc: Y.Doc, swap: ReadonlyMap<string, string>): void {
  doc.transact(() => {
    for (const image of paperImages(doc)) {
      const next = swap.get(String(image.getAttribute("fileId")))
      if (next) image.setAttribute("fileId", next)
    }
    for (const board of boardMaps(doc)) {
      for (const [key, element] of [...board.entries()]) {
        const next = swap.get(imageOf(element) ?? "")
        if (next) board.set(key, { ...(element as object), fileId: next })
      }
    }
  })
}

const copyOf = (value: unknown) => (value instanceof Y.AbstractType ? value.clone() : value)

const same = (a: unknown, b: unknown) =>
  !(a instanceof Y.AbstractType) && !(b instanceof Y.AbstractType) && JSON.stringify(a) === JSON.stringify(b)

type Versioned = { version: number; versionNonce?: number; updated?: number }

const versioned = (value: unknown): value is Versioned =>
  !!value && typeof value === "object" && !(value instanceof Y.AbstractType) && typeof (value as Versioned).version === "number"

/**
 * A board element put back by a restore. Boards keep the newest version of each element, so the old one comes back
 * with a version above the live one and a fresh nonce, or every open board would keep its own copy instead
 */
function restoredElement(old: unknown, live: unknown): unknown {
  if (!versioned(old)) return copyOf(old)
  const above = Math.max(old.version, versioned(live) ? live.version : 0) + 1
  return { ...old, version: above, versionNonce: randomInt(2 ** 31), updated: Date.now() }
}

/** Makes the target map hold exactly the source's entries, touching only those that differ */
function replaceEntries(target: Y.Map<unknown>, source: Y.Map<unknown>) {
  for (const key of [...target.keys()]) if (!source.has(key)) target.delete(key)
  for (const [key, value] of source.entries()) {
    if (!target.has(key) || !same(target.get(key), value)) target.set(key, restoredElement(value, target.get(key)))
  }
}

/** Puts an old state back into the live doc as one new change, so everyone connected sees it */
export function restoreInto(live: Y.Doc, old: Y.Doc): void {
  live.transact(() => {
    const text = live.getXmlFragment(TEXT_FIELD)
    text.delete(0, text.length)
    const children = old
      .getXmlFragment(TEXT_FIELD)
      .toArray()
      .map((child) => child.clone() as Y.XmlElement | Y.XmlText)
    if (children.length) text.insert(0, children)

    replaceEntries(live.getMap(BOARD_FIELD), old.getMap(BOARD_FIELD))

    const boards = live.getMap<unknown>(PAPER_BOARDS_FIELD)
    const oldBoards = old.getMap<unknown>(PAPER_BOARDS_FIELD)
    for (const key of [...boards.keys()]) if (!oldBoards.has(key)) boards.delete(key)
    for (const [key, oldBoard] of oldBoards.entries()) {
      const board = boards.get(key)
      if (board instanceof Y.Map && oldBoard instanceof Y.Map) replaceEntries(board, oldBoard)
      else boards.set(key, copyOf(oldBoard))
    }
  })
}
