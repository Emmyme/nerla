import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { NO_REFS } from "./docFormat"
import { applyDocWrite, docBlocks, docTasks } from "./docText"

const element = (name: string, attrs: Record<string, string | number | boolean>, children: (Y.XmlElement | Y.XmlText)[]) => {
  const node = new Y.XmlElement(name)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value as string)
  node.insert(0, children)
  return node
}

const paragraph = (value: string) => element("paragraph", {}, [new Y.XmlText(value)])
const taskItem = (value: string, checked: boolean) => element("taskItem", { checked }, [paragraph(value)])

/** A paper as the editor stores it: a heading, a paragraph and a two-line checklist */
function plan(): Y.Doc {
  const doc = new Y.Doc()
  doc
    .getXmlFragment("default")
    .insert(0, [
      element("heading", { level: 1 }, [new Y.XmlText("Plan")]),
      paragraph("Text"),
      element("taskList", {}, [taskItem("One", false), taskItem("Two", true)]),
    ])
  return doc
}

const lines = (doc: Y.Doc) => docBlocks(doc).text.split("\n")

const TASK = "dddddddd-0000-4000-8000-000000000004"
const IMAGE = "eeeeeeee-0000-4000-8000-000000000005"
const PAPER = "cccccccc-0000-4000-8000-000000000003"
const BOARD = "ffffffff-0000-4000-8000-000000000006"

describe("docBlocks", () => {
  it("reads one line per block, with each checklist line its own", () => {
    expect(lines(plan())).toEqual(["[b0] # Plan", "[b1] Text", "[b2] - [ ] One", "[b3] - [x] Two"])
  })
})

describe("applyDocWrite", () => {
  it("appends a checklist block", () => {
    const doc = plan()
    const result = applyDocWrite(doc, { op: "append", text: "- [ ] Three", revision: docBlocks(doc).revision })
    expect(result).toEqual({ ok: true, kept: [] })
    expect(lines(doc)[4]).toBe("[b4] - [ ] Three")
    const last = doc.getXmlFragment("default").toArray().at(-1) as Y.XmlElement
    expect(last.nodeName).toBe("taskList")
    expect((last.toArray()[0] as Y.XmlElement).getAttribute("checked")).toBe(false)
  })

  it("replaces only the block in the range", () => {
    const doc = plan()
    const before = doc.getXmlFragment("default").toArray()
    const result = applyDocWrite(doc, { op: "replace", from: "b1", to: "b1", text: "New", revision: docBlocks(doc).revision })
    expect(result).toEqual({ ok: true, kept: [] })
    expect(lines(doc)).toEqual(["[b0] # Plan", "[b1] New", "[b2] - [ ] One", "[b3] - [x] Two"])
    const after = doc.getXmlFragment("default").toArray()
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
  })

  it("refuses a stale revision", () => {
    const doc = plan()
    const { revision } = docBlocks(doc)
    doc.getXmlFragment("default").insert(0, [paragraph("Someone else")])
    expect(applyDocWrite(doc, { op: "append", text: "Late", revision })).toEqual({ ok: false, error: "The paper changed, read it again" })
  })
})

describe("revisions and refusals", () => {
  it("goes stale when a second client deletes a block, and reads the same from a copy", () => {
    const doc = plan()
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    const { revision } = docBlocks(doc)
    other.getXmlFragment("default").delete(1, 1)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other))
    expect(docBlocks(doc).revision).not.toBe(revision)
    expect(applyDocWrite(doc, { op: "append", text: "Late", revision })).toEqual({ ok: false, error: "The paper changed, read it again" })
    expect(docBlocks(other).revision).toBe(docBlocks(doc).revision)
  })

  it("refuses a replace of the whole paper", () => {
    const plain = plan()
    const whole = applyDocWrite(plain, { op: "replace", from: "b0", to: "b3", text: "", revision: docBlocks(plain).revision })
    expect(whole).toMatchObject({ ok: false, error: expect.stringContaining("whole paper") })
  })

  it("replaces marked text, a task line, an image and a drawn board with what it read, keeping them", () => {
    const doc = plan()
    const bold = new Y.XmlText()
    bold.insert(0, "Bold", { bold: {} })
    const fragment = doc.getXmlFragment("default")
    doc.getMap("boards").set(BOARD, new Y.Map())
    fragment.insert(2, [
      element("paragraph", {}, [bold]),
      element("image", { fileId: IMAGE, alt: "" }, []),
      element("boardBlock", { boardId: BOARD }, []),
    ])
    ;((fragment.get(5) as Y.XmlElement).get(0) as Y.XmlElement).setAttribute("taskId", TASK)
    const before = lines(doc)
    expect(before.slice(2, 6)).toEqual([
      "[b2] **Bold**",
      `[b3] ![](file:${IMAGE})`,
      `[b4] ![board](drawn:${BOARD})`,
      `[b5] - [ ] [One](task:${TASK})`,
    ])
    const refs = { ...NO_REFS, tasks: new Map([[TASK, { title: "One" }]]), images: new Map([[IMAGE, IMAGE]]) }
    const text = before
      .slice(2, 6)
      .map((line) => line.replace(/^\[b\d+\] /, ""))
      .join("\n")
    const result = applyDocWrite(doc, { op: "replace", from: "b2", to: "b5", text, revision: docBlocks(doc).revision }, refs)
    expect(result).toEqual({ ok: true, kept: [] })
    expect(lines(doc)).toEqual(before)
    const without = applyDocWrite(doc, { op: "replace", from: "b2", to: "b4", text: "**Bold**", revision: docBlocks(doc).revision }, refs)
    expect(without).toEqual({ ok: true, kept: [{ line: null, reason: expect.stringContaining(`drawn:${BOARD}`) }] })
  })

  it("keeps what a replaced range holds that the asker can't open", () => {
    const doc = plan()
    const links = new Y.XmlText()
    const fragment = doc.getXmlFragment("default")
    fragment.insert(2, [element("paragraph", {}, [links])])
    links.applyDelta([
      { insert: "Spec", attributes: { link: { href: `/paper/${PAPER}` } } },
      { insert: " and " },
      { insert: "call", attributes: { link: { href: "tel:+46123" } } },
    ])
    ;((fragment.get(3) as Y.XmlElement).get(0) as Y.XmlElement).setAttribute("taskId", TASK)
    const before = lines(doc)
    const text = before
      .slice(2, 4)
      .map((line) => line.replace(/^\[b\d+\] /, ""))
      .join("\n")
    expect(text).toBe(`[Spec](paper:${PAPER}) and [call](tel:+46123)\n- [ ] [One](task:${TASK})`)
    const result = applyDocWrite(doc, { op: "replace", from: "b2", to: "b3", text, revision: docBlocks(doc).revision })
    expect(result).toEqual({ ok: true, kept: [] })
    expect(lines(doc)).toEqual(before)
    expect(((fragment.get(3) as Y.XmlElement).get(0) as Y.XmlElement).getAttribute("taskId")).toBe(TASK)
  })

  it("writes a hidden task line back with its task, wherever it goes", () => {
    const doc = plan()
    const fragment = doc.getXmlFragment("default")
    ;((fragment.get(2) as Y.XmlElement).get(0) as Y.XmlElement).setAttribute("taskId", TASK)
    const read = docBlocks(doc, new Set([TASK]))
      .text.split("\n")[2]
      .replace(/^\[b\d+\] /, "")
    expect(read).toBe(`- [ ] [Hidden task: One](task:${TASK})`)
    const result = applyDocWrite(doc, { op: "append", text: read, revision: docBlocks(doc).revision }, { ...NO_REFS, tasks: docTasks(doc) })
    expect(result).toEqual({ ok: true, kept: [] })
    expect(lines(doc).at(-1)).toBe(`[b4] - [ ] [One](task:${TASK})`)
  })

  it("refuses a replace of every real block when the last line is empty", () => {
    const doc = plan()
    doc.getXmlFragment("default").push([element("paragraph", {}, [])])
    const result = applyDocWrite(doc, { op: "replace", from: "b0", to: "b3", text: "", revision: docBlocks(doc).revision })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("whole paper") })
  })
})
