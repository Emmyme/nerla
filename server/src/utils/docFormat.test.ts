import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { docToText, NO_REFS, type Resolved } from "./docFormat"
import { applyDocWrite, docBlocks, revisionOf } from "./docText"

const A = "aaaaaaaa-0000-4000-8000-000000000001"
const B = "bbbbbbbb-0000-4000-8000-000000000002"
const P = "cccccccc-0000-4000-8000-000000000003"
const T = "dddddddd-0000-4000-8000-000000000004"
const F = "eeeeeeee-0000-4000-8000-000000000005"
const F2 = "ffffffff-0000-4000-8000-000000000006"

/** Appends the text to an empty paper and reads it back */
function write(text: string, refs: Partial<Resolved> = {}) {
  const doc = new Y.Doc()
  const result = applyDocWrite(doc, { op: "append", text, revision: revisionOf(doc) }, { ...NO_REFS, ...refs })
  if (!result.ok) throw new Error(result.error)
  const top = doc.getXmlFragment("default").toArray() as Y.XmlElement[]
  return { doc, top, kept: result.kept, text: docToText(doc).join("\n") }
}

const child = (node: Y.XmlElement, ...path: number[]) => path.reduce((at, index) => at.get(index) as Y.XmlElement, node)
const delta = (node: Y.XmlElement) =>
  (node.get(0) as unknown as Y.XmlText).toDelta() as { insert: string; attributes?: Record<string, unknown> }[]
const names = (node: Y.XmlElement | Y.XmlFragment) => (node.toArray() as Y.XmlElement[]).map((one) => one.nodeName)

describe("the paper format", () => {
  it("keeps headings 1 to 3 and turns #### into text", () => {
    const { top, kept, text } = write("# One\n## Two\n### Three\n#### Four")
    expect(top.map((node) => [node.nodeName, node.getAttribute("level")])).toEqual([
      ["heading", 1],
      ["heading", 2],
      ["heading", 3],
      ["paragraph", undefined],
    ])
    expect(text).toBe("# One\n## Two\n### Three\n\\#### Four")
    expect(kept).toEqual([{ line: 4, reason: expect.stringContaining("###") }])
  })

  it("writes bold, italic, underline, strike and code marks", () => {
    const line = "**a** _b_ <u>c</u> ~~d~~ `e`"
    const { top, text } = write(line)
    expect(top).toHaveLength(1)
    const marked = delta(top[0]).filter((op) => op.attributes)
    expect(marked.map((op) => [op.insert, op.attributes])).toEqual([
      ["a", { bold: {} }],
      ["b", { italic: {} }],
      ["c", { underline: {} }],
      ["d", { strike: {} }],
      ["e", { code: {} }],
    ])
    expect(text).toBe(line)
  })

  it("writes web links and keeps other schemes as text", () => {
    const line = `[x](https://e.com) and https://e.com and [y](paper:${P}) and [z](javascript:alert(1))`
    const { top, kept, text } = write(line, { links: new Map([[`paper:${P}`, `/paper/${P}`]]) })
    const links = delta(top[0]).filter((op) => op.attributes)
    expect(links.map((op) => [op.insert, op.attributes])).toEqual([
      ["x", { link: { href: "https://e.com" } }],
      ["https://e.com", { link: { href: "https://e.com" } }],
      ["y", { link: { href: `/paper/${P}` } }],
    ])
    expect(delta(top[0]).at(-1)!.insert).toBe(" and [z](javascript:alert(1))")
    expect(kept).toEqual([{ line: 1, reason: expect.stringContaining("https://") }])
    expect(text).toBe(`[x](https://e.com) and https://e.com and [y](paper:${P}) and \\[z\\](javascript:alert(1))`)
  })

  it("nests lists by two spaces", () => {
    const written = "- a\n  - b\n    1. c\n- d"
    const { top, text } = write(written)
    expect(names(top[0])).toEqual(["listItem", "listItem"])
    expect(names(child(top[0], 0))).toEqual(["paragraph", "bulletList"])
    expect(names(child(top[0], 0, 1, 0))).toEqual(["paragraph", "orderedList"])
    expect(text).toBe(written)
  })

  it("keeps a checklist line's checked state", () => {
    const { top, text } = write("- [ ] one\n- [x] two")
    expect((top[0].toArray() as Y.XmlElement[]).map((item) => item.getAttribute("checked"))).toEqual([false, true])
    expect(text).toBe("- [ ] one\n- [x] two")
  })

  it("writes a task line for a resolved task", () => {
    const { top, kept, text } = write(`- [x] [Old name](task:${T})`, { tasks: new Map([[T, { title: "Fix login" }]]) })
    const item = child(top[0], 0)
    expect([item.nodeName, item.getAttribute("taskId"), item.getAttribute("checked")]).toEqual(["taskItem", T, true])
    expect(kept).toEqual([])
    expect(text).toBe(`- [x] [Fix login](task:${T})`)
  })

  it("keeps a task line for an unknown task as text", () => {
    const { top, kept, text } = write(`- [ ] [Fix login](task:${T})`)
    expect(child(top[0], 0).getAttribute("taskId")).toBeUndefined()
    expect(kept).toEqual([{ line: 1, reason: expect.any(String) }])
    expect(text).toBe(`- [ ] \\[Fix login\\](task:${T})`)
  })

  it("writes quotes, code blocks with a language and dividers", () => {
    const written = "> quoted **bold**\n> - item\n```ts\nconst a = 1\n\n```\n---"
    const { top, text } = write(written)
    expect(top.map((node) => node.nodeName)).toEqual(["blockquote", "codeBlock", "horizontalRule"])
    expect(names(top[0])).toEqual(["paragraph", "bulletList"])
    expect(top[1].getAttribute("language")).toBe("ts")
    expect(text).toBe(written)
  })

  it("writes a table with a header row and marks in its cells", () => {
    const written = "| Name | **Due** |\n| --- | --- |\n| [x](https://e.com) | `soon` |"
    const { top, text } = write(written)
    expect(names(top[0])).toEqual(["tableRow", "tableRow"])
    expect(names(child(top[0], 0))).toEqual(["tableHeader", "tableHeader"])
    expect(names(child(top[0], 1))).toEqual(["tableCell", "tableCell"])
    expect(delta(child(top[0], 0, 1, 0))).toEqual([{ insert: "Due", attributes: { bold: {} } }])
    expect(delta(child(top[0], 1, 1, 0))).toEqual([{ insert: "soon", attributes: { code: {} } }])
    expect(text).toBe(written)
  })

  it("refuses more than 50 rows", () => {
    const table = (rows: number) => ["| a |", "| --- |", ...Array.from({ length: rows }, (_, i) => `| ${i} |`)].join("\n")
    const doc = new Y.Doc()
    expect(applyDocWrite(doc, { op: "append", text: table(49), revision: revisionOf(doc) })).toMatchObject({ ok: true })
    expect(applyDocWrite(doc, { op: "append", text: table(50), revision: revisionOf(doc) })).toEqual({
      ok: false,
      error: "A table can have at most 50 rows of 10 cells",
    })
  })

  it("writes a mention only for a user on the paper", () => {
    const { top, kept, text } = write(`Hi @[Theodore](person:${A}) and @[Sara](person:${B})`, { people: new Map([[A, "Theo"]]) })
    const mention = top[0].get(1) as Y.XmlElement
    expect([mention.nodeName, mention.getAttribute("id"), mention.getAttribute("label")]).toEqual(["mention", A, "Theo"])
    expect(kept).toEqual([{ line: 1, reason: expect.stringContaining("Sara") }])
    expect(text).toBe(`Hi @[Theo](person:${A}) and @\\[Sara\\](person:${B})`)
  })

  it("copies nothing from the web", () => {
    const { top, kept, text } = write(`![a](https://e.com/x.png)\n![b](file:${F})`, { images: new Map([[F, F2]]) })
    expect(top.map((node) => node.nodeName)).toEqual(["paragraph", "image"])
    expect(delta(top[0])).toEqual([{ insert: "![a](https://e.com/x.png)" }])
    expect([top[1].getAttribute("fileId"), top[1].getAttribute("alt")]).toEqual([F2, "b"])
    expect(kept).toEqual([{ line: 1, reason: expect.stringContaining("file:") }])
    expect(text).toBe(`!\\[a\\](https\\://e.com/x.png)\n![b](file:${F2})`)
  })

  it("writes board embeds", () => {
    const { doc, top, text } = write(`![board](board:${B})\n![board](board:new)`, { boards: new Set([B]) })
    expect(top.map((node) => node.nodeName)).toEqual(["boardLink", "boardBlock"])
    expect(top[0].getAttribute("fileId")).toBe(B)
    const boardId = String(top[1].getAttribute("boardId"))
    expect(doc.getMap("boards").get(boardId)).toBeInstanceOf(Y.Map)
    expect(text).toBe(`![board](board:${B})\n![board](drawn:${boardId})`)
  })

  it("keeps unknown tags as text", () => {
    const { top, kept, text } = write("<span>x</span>")
    expect(delta(top[0])).toEqual([{ insert: "<span>x</span>" }])
    expect(kept.length).toBeGreaterThan(0)
    expect(text).toBe("\\<span>x\\</span>")
  })

  it("refuses a replace over an unsupported block", () => {
    const doc = new Y.Doc()
    const cell = (name: string, colspan: number) => {
      const node = new Y.XmlElement(name)
      node.setAttribute("colspan", colspan as unknown as string)
      node.insert(0, [new Y.XmlElement("paragraph")])
      return node
    }
    const row = new Y.XmlElement("tableRow")
    row.insert(0, [cell("tableHeader", 2)])
    const table = new Y.XmlElement("table")
    table.insert(0, [row])
    const paragraph = new Y.XmlElement("paragraph")
    paragraph.insert(0, [new Y.XmlText("Intro")])
    const outro = new Y.XmlElement("paragraph")
    outro.insert(0, [new Y.XmlText("Outro")])
    doc.getXmlFragment("default").insert(0, [paragraph, table, outro])
    expect(docBlocks(doc).text.split("\n")[1]).toBe("[b1] [unsupported: tableHeader]")
    const revision = revisionOf(doc)
    expect(applyDocWrite(doc, { op: "replace", from: "b0", to: "b1", text: "New", revision })).toEqual({
      ok: false,
      error: "b1 holds something you can't rewrite. Leave it out of the range",
    })
    expect(applyDocWrite(doc, { op: "replace", from: "b0", to: "b0", text: "New", revision })).toMatchObject({ ok: true })
  })
})
