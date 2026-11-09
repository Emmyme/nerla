import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { mentionIdsIn, restoreInto } from "./docYjs"

const ANNA = "6f1c2a0e-4b7d-4c8e-9a1f-2b3c4d5e6f70"
const BO = "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d"

const mention = (id: string) => {
  const node = new Y.XmlElement("mention")
  node.setAttribute("id", id)
  return node
}

const paragraph = (...children: (Y.XmlElement | Y.XmlText)[]) => {
  const node = new Y.XmlElement("paragraph")
  node.insert(0, children)
  return node
}

const text = (value: string) => new Y.XmlText(value)

const textOf = (doc: Y.Doc) => doc.getXmlFragment("default").toString()

describe("mentionIdsIn", () => {
  it("finds the mentions in nested lists, each once", () => {
    const doc = new Y.Doc()
    const item = new Y.XmlElement("listItem")
    item.insert(0, [paragraph(text("ask "), mention(BO))])
    const list = new Y.XmlElement("bulletList")
    list.insert(0, [item])
    doc.getXmlFragment("default").insert(0, [paragraph(mention(ANNA), text(" and "), mention(BO)), list])
    expect(mentionIdsIn(doc).sort()).toEqual([ANNA, BO].sort())
  })
})

describe("restoreInto", () => {
  const oldDoc = () => {
    const doc = new Y.Doc()
    doc.getXmlFragment("default").insert(0, [paragraph(text("old text"))])
    const board = new Y.Map<unknown>()
    board.set("e1", { id: "e1", version: 1 })
    board.set("gone", { id: "gone", version: 1 })
    doc.getMap<Y.Map<unknown>>("boards").set("b1", board)
    return doc
  }

  it("brings back the old text and elements without replacing the live doc", () => {
    const old = oldDoc()
    const live = new Y.Doc()
    Y.applyUpdate(live, Y.encodeStateAsUpdate(old))
    const fragment = live.getXmlFragment("default")
    fragment.delete(0, fragment.length)
    fragment.insert(0, [paragraph(text("new text"))])
    live.getMap<Y.Map<unknown>>("boards").get("b1")!.set("e2", { id: "e2", version: 1 })
    const clientId = live.clientID

    restoreInto(live, old)

    expect(textOf(live)).toBe(textOf(old))
    expect(textOf(live)).toContain("old text")
    expect([...live.getMap<Y.Map<unknown>>("boards").get("b1")!.keys()].sort()).toEqual(["e1", "gone"])
    expect(live.clientID).toBe(clientId)
  })

  it("gives a restored board element a version above the live one, so open boards take it", () => {
    const old = oldDoc()
    const live = new Y.Doc()
    Y.applyUpdate(live, Y.encodeStateAsUpdate(old))
    live.getMap<Y.Map<unknown>>("boards").get("b1")!.set("e1", { id: "e1", version: 7, versionNonce: 3, x: 50 })

    restoreInto(live, old)

    const restored = live.getMap<Y.Map<unknown>>("boards").get("b1")!.get("e1") as { version: number; versionNonce: number; x?: number }
    expect(restored.version).toBe(8)
    expect(restored.x).toBeUndefined()
    expect(restored.versionNonce).not.toBe(3)
  })

  it("drops a board element the old doc had deleted", () => {
    const old = oldDoc()
    const live = new Y.Doc()
    Y.applyUpdate(live, Y.encodeStateAsUpdate(old))
    old.getMap<Y.Map<unknown>>("boards").get("b1")!.delete("gone")

    restoreInto(live, old)

    expect(live.getMap<Y.Map<unknown>>("boards").get("b1")!.has("gone")).toBe(false)
    expect(live.getMap<Y.Map<unknown>>("boards").get("b1")!.has("e1")).toBe(true)
  })
})
