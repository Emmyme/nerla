import * as Y from "yjs"
import { REASONS, withMark, type DocNode, type Inline, type Kept, type ListItem, type Mark, type Resolved } from "./types"

type Run = { text: string; attributes?: Record<string, object> }
export type Spec = { name: string; attrs?: Record<string, unknown>; children?: (Spec | Run)[] }

const isRun = (child: Spec | Run): child is Run => "text" in child

/** A spec as the Yjs element y-tiptap would store, with each mark a format attribute holding its attributes */
export function toY(spec: Spec): Y.XmlElement {
  const node = new Y.XmlElement(spec.name)
  for (const [key, value] of Object.entries(spec.attrs ?? {}))
    if (value !== null && value !== undefined) node.setAttribute(key, value as string)
  const children: (Y.XmlElement | Y.XmlText)[] = []
  let runs: Run[] = []
  const flush = () => {
    if (!runs.length) return
    const text = new Y.XmlText()
    text.applyDelta(runs.map((run) => (run.attributes ? { insert: run.text, attributes: run.attributes } : { insert: run.text })))
    children.push(text)
    runs = []
  }
  for (const child of spec.children ?? []) {
    if (isRun(child)) {
      if (child.text) runs.push(child)
    } else {
      flush()
      children.push(toY(child))
    }
  }
  flush()
  if (children.length) node.insert(0, children)
  return node
}

const markAttrs = (marks: Mark[]): Record<string, object> | undefined =>
  marks.length ? Object.fromEntries(marks.map((mark) => [mark.type, mark.type === "link" ? { href: mark.href } : {}])) : undefined

const run = (text: string, marks: Mark[]): Run => {
  const attributes = markAttrs(marks)
  return attributes ? { text, attributes } : { text }
}

type Build = { resolved: Resolved; ids: { newId(): string }; boards: { boardId: string }[]; kept: Kept[]; drawn: Set<string> }

const keep = (build: Build, line: number, reason: string) => {
  if (!build.kept.some((one) => one.line === line && one.reason === reason)) build.kept.push({ line, reason })
}

function inlineSpecs(inline: Inline[], build: Build, extra: Mark[] = []): (Spec | Run)[] {
  return inline.flatMap((one): (Spec | Run)[] => {
    if ("br" in one) return [{ name: "hardBreak" }]
    if ("mention" in one) {
      const label = build.resolved.people.get(one.mention)
      if (label) return [{ name: "mention", attrs: { id: one.mention, label } }]
      keep(build, one.line, REASONS.mention(one.label))
      return [run(one.raw, [])]
    }
    if ("otherLink" in one) {
      const href = build.resolved.hrefs.get(one.otherLink)
      if (href) return inlineSpecs(one.inline, build, [{ type: "link", href }])
      keep(build, one.line, one.reason)
      return [run(one.raw, one.marks)]
    }
    if ("itemLink" in one) {
      const href = build.resolved.links.get(`${one.itemLink.kind}:${one.itemLink.id}`)
      if (href) return inlineSpecs(one.inline, build, [{ type: "link", href }])
      keep(build, one.line, REASONS.item(one.itemLink.kind, one.itemLink.id))
      return [run(one.raw, one.marks)]
    }
    if (one.reason && one.line) keep(build, one.line, one.reason)
    // Code takes no other mark in the editor
    const marks = one.marks.some((mark) => mark.type === "code") ? [{ type: "code" as const }] : extra.reduce(withMark, one.marks)
    return [run(one.text, marks)]
  })
}

const paragraph = (children: (Spec | Run)[]): Spec => ({ name: "paragraph", children })

function itemSpec(item: ListItem, build: Build): Spec {
  let attrs: Record<string, unknown> | undefined
  let head: (Spec | Run)[]
  if (item.type === "taskItem") {
    attrs = { checked: item.checked }
    const task = item.task && build.resolved.tasks.get(item.task.id)
    if (item.task && task) {
      attrs.taskId = item.task.id
      head = [run(task.title, [])]
    } else if (item.task) {
      keep(build, item.line, REASONS.item("task", item.task.id))
      head = [run(item.task.raw, [])]
    } else head = inlineSpecs(item.inline, build)
  } else head = inlineSpecs(item.inline, build)
  return { name: item.type, attrs, children: [paragraph(head), ...item.children.map((child) => nodeSpec(child, build))] }
}

const cell = (name: string, inline: Inline[], build: Build): Spec => ({
  name,
  attrs: { colspan: 1, rowspan: 1 },
  children: [paragraph(inlineSpecs(inline, build))],
})

function nodeSpec(node: DocNode, build: Build): Spec {
  const { resolved } = build
  switch (node.type) {
    case "paragraph":
      return paragraph(inlineSpecs(node.inline, build))
    case "heading":
      return { name: "heading", attrs: { level: node.level }, children: inlineSpecs(node.inline, build) }
    case "blockquote":
      return { name: "blockquote", children: node.children.map((child) => nodeSpec(child, build)) }
    case "codeBlock":
      return { name: "codeBlock", attrs: { language: node.language }, children: [{ text: node.code }] }
    case "horizontalRule":
      return { name: "horizontalRule" }
    case "bulletList":
    case "taskList":
      return { name: node.type, children: node.items.map((item) => itemSpec(item, build)) }
    case "orderedList":
      return { name: node.type, attrs: { start: node.start }, children: node.items.map((item) => itemSpec(item, build)) }
    case "table":
      return {
        name: "table",
        children: [
          { name: "tableRow", children: node.header.map((inline) => cell("tableHeader", inline, build)) },
          ...node.rows.map((row) => ({ name: "tableRow", children: row.map((inline) => cell("tableCell", inline, build)) })),
        ],
      }
    case "image": {
      const fileId = resolved.images.get(node.fileId)
      if (fileId) return { name: "image", attrs: { fileId, alt: node.alt } }
      keep(build, node.line, REASONS.image(node.fileId))
      return paragraph([run(node.raw, [])])
    }
    case "boardLink":
      if (resolved.boards.has(node.fileId)) return { name: "boardLink", attrs: { fileId: node.fileId } }
      keep(build, node.line, REASONS.board(node.fileId))
      return paragraph([run(node.raw, [])])
    case "boardBlock": {
      if ("new" in node) {
        const boardId = build.ids.newId()
        build.boards.push({ boardId })
        return { name: "boardBlock", attrs: { boardId } }
      }
      // Each drawn board shows once, so two blocks never share one
      if (build.drawn.delete(node.boardId)) return { name: "boardBlock", attrs: { boardId: node.boardId } }
      keep(build, node.line, REASONS.drawn(node.boardId))
      return paragraph([run(node.raw, [])])
    }
    case "text":
      keep(build, node.line, node.reason)
      return paragraph([run(node.text, [])])
  }
}

/** The blocks as specs to build, the new boards they draw and what stayed as text */
export function docSpecs(
  nodes: DocNode[],
  resolved: Resolved,
  ids: { newId(): string },
): { specs: Spec[]; boards: { boardId: string }[]; kept: Kept[] } {
  const build: Build = { resolved, ids, boards: [], kept: [], drawn: new Set(resolved.drawn) }
  const specs = nodes.map((node) => nodeSpec(node, build))
  return { specs, boards: build.boards, kept: build.kept.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)) }
}
