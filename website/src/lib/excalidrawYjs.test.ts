import { describe, expect, it, vi } from "vitest"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import * as Y from "yjs"
import { applyRemote, bindBoard, changedElements } from "./excalidrawYjs"

const element = (id: string, version: number, index: string | null, extra: Partial<ExcalidrawElement> = {}) =>
  ({ id, version, versionNonce: version * 7, index, type: "rectangle", isDeleted: false, ...extra }) as unknown as ExcalidrawElement

describe("changedElements", () => {
  it("returns only the elements whose version rose, deleted ones included", () => {
    const prev = new Map([
      ["a", 3],
      ["b", 5],
      ["c", 2],
    ])
    const next = [element("a", 3, "a0"), element("b", 6, "a1", { isDeleted: true }), element("c", 4, "a2"), element("d", 1, "a3")]
    expect(changedElements(prev, next).map((e) => [e.id, e.isDeleted])).toEqual([
      ["b", true],
      ["c", false],
      ["d", false],
    ])
  })

  it("leaves an unchanged element out", () => {
    expect(changedElements(new Map([["a", 3]]), [element("a", 3, "a0")])).toEqual([])
  })
})

describe("applyRemote", () => {
  it("keeps the order by index", () => {
    const entries: [string, unknown][] = [
      ["c", element("c", 1, "a2")],
      ["a", element("a", 1, "a0")],
      ["b", element("b", 1, "a1")],
    ]
    expect(applyRemote(entries).map((e) => e.id)).toEqual(["a", "b", "c"])
  })
})

describe("bindBoard", () => {
  type Element = ExcalidrawElement & { x: number }
  /** Just enough of Excalidraw: a scene, updateScene and onChange */
  function fakeBoard(map: Y.Map<unknown>) {
    let scene: Element[] = []
    const listeners = new Set<(elements: readonly ExcalidrawElement[]) => void>()
    const api = {
      getSceneElementsIncludingDeleted: () => scene,
      updateScene: ({ elements }: { elements?: readonly ExcalidrawElement[] }) => {
        if (!elements) return
        scene = [...elements] as Element[]
        listeners.forEach((listener) => listener(scene))
      },
      onChange: (listener: (elements: readonly ExcalidrawElement[]) => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    } as unknown as ExcalidrawImperativeAPI
    const unbind = bindBoard(map, api)
    return {
      scene: () => scene,
      x: (id: string) => scene.find((e) => e.id === id)?.x,
      edit: (id: string, x: number, nonce: number) => {
        scene = scene.map((e) => (e.id === id ? { ...e, x, version: e.version + 1, versionNonce: nonce } : e))
        listeners.forEach((listener) => listener(scene))
      },
      add: (element: Element) => {
        scene = [...scene, element]
        listeners.forEach((listener) => listener(scene))
      },
      unbind,
    }
  }

  /** Two docs that pass every change to each other, as the live server does */
  function pair() {
    const a = new Y.Doc()
    const b = new Y.Doc()
    a.on("update", (update: Uint8Array, origin: unknown) => origin !== "wire" && Y.applyUpdate(b, update, "wire"))
    b.on("update", (update: Uint8Array, origin: unknown) => origin !== "wire" && Y.applyUpdate(a, update, "wire"))
    return { a, b, one: fakeBoard(a.getMap("board")), two: fakeBoard(b.getMap("board")) }
  }

  it("converges after concurrent edits, takes a restore and drops a deleted key", () => {
    vi.useFakeTimers()
    const { a, one, two } = pair()
    one.add({ ...element("r", 1, "a0"), x: 0 } as Element)
    vi.advanceTimersByTime(100)
    expect(two.x("r")).toBe(0)

    // Both move the same element at once, without seeing each other until they write
    one.edit("r", 10, 111)
    two.edit("r", 20, 222)
    vi.advanceTimersByTime(100)
    expect(one.x("r")).toBe(two.x("r"))

    // A restore writes the old drawing back above the live version
    const live = a.getMap("board").get("r") as Element
    a.transact(() => a.getMap("board").set("r", { ...element("r", live.version + 1, "a0"), versionNonce: 999, x: 0 }), "server")
    vi.advanceTimersByTime(100)
    expect(one.x("r")).toBe(0)
    expect(two.x("r")).toBe(0)

    // A restore that removes an element removes it from every open board, and nobody writes it back
    one.add({ ...element("s", 1, "a1"), x: 5 } as Element)
    vi.advanceTimersByTime(100)
    expect(two.x("s")).toBe(5)
    a.transact(() => a.getMap("board").delete("s"), "server")
    vi.advanceTimersByTime(100)
    one.edit("r", 30, 333)
    vi.advanceTimersByTime(100)
    expect(one.scene().some((e) => e.id === "s")).toBe(false)
    expect(two.scene().some((e) => e.id === "s")).toBe(false)
    expect(a.getMap("board").has("s")).toBe(false)
    expect(two.x("r")).toBe(30)
    one.unbind()
    two.unbind()
    vi.useRealTimers()
  })
})
