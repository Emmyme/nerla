import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { AppState, Collaborator, ExcalidrawImperativeAPI, SocketId } from "@excalidraw/excalidraw/types"
import type { Awareness } from "y-protocols/awareness"
import type * as Y from "yjs"

/** Marks the board's own writes, so its observer skips them */
const LOCAL = Symbol("board-local")
/** Drags and strokes change an element many times a second, so writes are gathered for a moment */
const PUSH_MS = 50
const POINTER_MS = 50
/** Remote changes stay out of the local undo stack */
const NEVER = "NEVER" as const

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The fonts boards ship with: Cascadia, Excalifont and Nunito. Text in any other is drawn in Excalifont */
const FONTS: ReadonlySet<number> = new Set([3, 5, 6])
const DEFAULT_FONT = 5

const offFont = (element: ExcalidrawElement) => element.type === "text" && !FONTS.has(element.fontFamily)
const inFont = <T extends ExcalidrawElement>(element: T): T => (offFont(element) ? { ...element, fontFamily: DEFAULT_FONT } : element)

const isElement = (value: unknown): value is ExcalidrawElement =>
  !!value &&
  typeof value === "object" &&
  typeof (value as ExcalidrawElement).id === "string" &&
  typeof (value as ExcalidrawElement).version === "number"

/** The elements whose version rose since `prev`, deleted ones included */
export function changedElements(prev: Map<string, number>, next: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  return next.filter((element) => element.version > (prev.get(element.id) ?? 0))
}

const byIndex = (a: ExcalidrawElement, b: ExcalidrawElement) => {
  if (a.index === b.index) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  if (a.index === null) return 1
  if (b.index === null) return -1
  return a.index < b.index ? -1 : 1
}

/** A board map's elements in drawing order */
export function applyRemote(entries: Iterable<[string, unknown]>): ExcalidrawElement[] {
  const elements: ExcalidrawElement[] = []
  for (const [id, value] of entries) if (isElement(value) && value.id === id) elements.push(inFont(value))
  return elements.sort(byIndex)
}

/**
 * Keeps a board's scene and its Y.Map of elements in step. The map is the shared truth: a remote element replaces the
 * local one unless the local one is newer, which is then written again. Image bytes never enter the map.
 */
export function bindBoard(map: Y.Map<unknown>, api: ExcalidrawImperativeAPI): () => void {
  const seen = new Map<string, number>()
  let pending = new Map<string, ExcalidrawElement>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (pending.size === 0) return
    const batch = pending
    pending = new Map()
    const write = () => batch.forEach((element, id) => map.set(id, clone(element)))
    if (map.doc) map.doc.transact(write, LOCAL)
    else write()
  }
  const queue = (element: ExcalidrawElement) => {
    seen.set(element.id, element.version)
    pending.set(element.id, element)
    timer ??= setTimeout(flush, PUSH_MS)
  }

  const fromMap = (removed: ReadonlySet<string> = new Set()) => {
    for (const id of removed) {
      seen.delete(id)
      pending.delete(id)
    }
    const scene = api.getSceneElementsIncludingDeleted()
    const mine = new Map(scene.map((element) => [element.id, element]))
    const merged = new Map<string, ExcalidrawElement>()
    let changed = false
    for (const theirs of applyRemote(map.entries())) {
      const own = pending.get(theirs.id) ?? mine.get(theirs.id)
      if (own && own.version > theirs.version) {
        merged.set(own.id, own)
        if (!pending.has(own.id)) queue(own)
      } else if (own && own.version === theirs.version && own.versionNonce === theirs.versionNonce) {
        merged.set(own.id, own)
        seen.set(own.id, own.version)
      } else {
        merged.set(theirs.id, clone(theirs))
        seen.set(theirs.id, theirs.version)
        pending.delete(theirs.id)
        changed = true
      }
    }
    for (const element of scene) {
      if (removed.has(element.id)) changed = true
      else if (!merged.has(element.id)) merged.set(element.id, element)
    }
    if (changed) api.updateScene({ elements: applyRemote(merged.entries()), captureUpdate: NEVER })
  }

  // A key that leaves the map, as a restore does, leaves every open board too
  const observer = (event: Y.YMapEvent<unknown>, transaction: Y.Transaction) => {
    if (transaction.origin === LOCAL) return
    const removed = new Set([...event.keysChanged].filter((key) => !map.has(key)))
    fromMap(removed)
  }
  map.observe(observer)
  fromMap()
  const unsubscribe = api.onChange((elements) => {
    const changed = changedElements(seen, elements)
    // Text pasted or set in a font boards don't ship goes back to Excalifont, here and for everyone
    if (changed.some(offFont)) {
      const fixed = elements.map((element) =>
        offFont(element)
          ? { ...inFont(element), version: element.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() }
          : element,
      )
      api.updateScene({ elements: fixed, captureUpdate: NEVER })
      return
    }
    for (const element of changed) queue(element)
  })

  return () => {
    unsubscribe()
    map.unobserve(observer)
    flush()
  }
}

/** What one user shares about a board through awareness */
type BoardPresence = {
  key: string
  x: number
  y: number
  tool: "pointer" | "laser"
  button: "up" | "down"
  selected: string[]
}

/** Name and color only. Guests share the board, so no member's id goes into awareness */
type PeerState = { user?: { name?: string; color?: string }; board?: BoardPresence | null }

/** Excalidraw's own hue for a collaborator id, as it colors pointers and avatars */
function excalidrawHue(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash << 5) - hash + id.charCodeAt(i)
  return (Math.abs(hash) % 37) * 10
}

function hueOf(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const span = max - Math.min(r, g, b)
  if (!span) return 0
  const hue = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4
  return (hue * 60 + 360) % 360
}

const picked = new Map<string, string>()

/**
 * Excalidraw colors a collaborator by hashing their id and ignores any color given, so the id carries a suffix
 * that lands on the hue of the user's Nerla color
 */
function collaboratorId(key: string, color: string): string {
  const cacheKey = `${key}|${color}`
  const known = picked.get(cacheKey)
  if (known) return known
  const want = (Math.round(hueOf(color) / 10) * 10) % 360
  let id = key
  for (let n = 0; n < 400; n++) {
    const candidate = `${key}~${n}`
    if (excalidrawHue(candidate) === want) {
      id = candidate
      break
    }
  }
  picked.set(cacheKey, id)
  return id
}

/**
 * Shows the others on the same board as Excalidraw collaborators, with their names and colors, and returns the
 * function that shares the user's own pointer. `key` tells boards inside one paper apart.
 */
export function bindPresence(
  awareness: Awareness,
  api: ExcalidrawImperativeAPI,
  key: string,
): { pointer: (pointer: { x: number; y: number; tool: "pointer" | "laser" }, button: "up" | "down") => void; destroy: () => void } {
  let last: BoardPresence | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const show = () => {
    const collaborators = new Map<SocketId, Collaborator>()
    awareness.getStates().forEach((state: PeerState, clientId) => {
      if (clientId === awareness.clientID || state.board?.key !== key) return
      const color = state.user?.color ?? "#7CC2F7"
      collaborators.set(String(clientId) as SocketId, {
        id: collaboratorId(String(clientId), color),
        socketId: String(clientId) as SocketId,
        username: state.user?.name ?? "Guest",
        color: { background: color, stroke: color },
        pointer: { x: state.board.x, y: state.board.y, tool: state.board.tool },
        button: state.board.button,
        selectedElementIds: Object.fromEntries(state.board.selected.map((id) => [id, true])) as AppState["selectedElementIds"],
      })
    })
    api.updateScene({ collaborators, captureUpdate: NEVER })
  }

  const send = () => {
    timer = null
    if (last) awareness.setLocalStateField("board", last)
  }

  const onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    if ([...added, ...updated, ...removed].some((id) => id !== awareness.clientID)) show()
  }
  awareness.on("change", onChange)
  show()

  return {
    pointer: (pointer, button) => {
      const selected = Object.keys(api.getAppState().selectedElementIds ?? {})
      last = { key, x: pointer.x, y: pointer.y, tool: pointer.tool, button, selected }
      timer ??= setTimeout(send, POINTER_MS)
    },
    destroy: () => {
      if (timer) clearTimeout(timer)
      awareness.off("change", onChange)
      if ((awareness.getLocalState() as PeerState | null)?.board?.key === key) awareness.setLocalStateField("board", null)
    },
  }
}
