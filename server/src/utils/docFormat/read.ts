import * as Y from "yjs"
import { TEXT_FIELD } from "../docYjs"
import { UUID } from "../uuid"
import { bareUrl, HIDDEN_TASK, isWordChar, MARK_ORDER, type Resolved } from "./types"

class Unsupported extends Error {
  constructor(readonly node: string) {
    super(node)
  }
}

const LISTS = new Set(["bulletList", "orderedList", "taskList"])

/** A block as the reader sees it: a top-level block, or one line of a top-level list */
export type Unit = { block: Y.XmlElement; item: Y.XmlElement | null }

export const elements = (node: Y.XmlFragment | Y.XmlElement): Y.XmlElement[] =>
  node.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement)

export function unitsOf(doc: Y.Doc): Unit[] {
  return elements(doc.getXmlFragment(TEXT_FIELD)).flatMap((block): Unit[] => {
    const items = LISTS.has(block.nodeName) ? elements(block) : []
    return items.length ? items.map((item) => ({ block, item })) : [{ block, item: null }]
  })
}

type Piece = { text: string; keys: string[]; href: Map<string, string> } | { atom: string }

const KNOWN_MARKS = new Set(["bold", "italic", "underline", "strike", "code"])

function pieces(node: Y.XmlElement): Piece[] {
  return node.toArray().flatMap((child): Piece[] => {
    if (child instanceof Y.XmlText) {
      return (child.toDelta() as { insert?: unknown; attributes?: Record<string, unknown> }[]).map((op) => {
        if (typeof op.insert !== "string") throw new Unsupported("embed")
        const keys: string[] = []
        const href = new Map<string, string>()
        for (const [name, value] of Object.entries(op.attributes ?? {})) {
          if (value === null || value === undefined || value === false) continue
          if (name === "link") {
            const target = (value as { href?: unknown }).href
            if (typeof target !== "string" || !target) throw new Unsupported("link")
            keys.push(`link:${target}`)
            href.set(`link:${target}`, target)
          } else if (KNOWN_MARKS.has(name)) keys.push(name)
          else throw new Unsupported(name.replace(/--.*$/, ""))
        }
        return { text: op.insert, keys: keys.includes("code") ? ["code"] : keys, href }
      })
    }
    if (!(child instanceof Y.XmlElement)) return []
    if (child.nodeName === "hardBreak") return [{ atom: "<br>" }]
    if (child.nodeName === "mention") {
      const id = child.getAttribute("id")
      if (typeof id !== "string" || !id) throw new Unsupported("mention")
      return [{ atom: `@[${escapeText(String(child.getAttribute("label") ?? ""), false)}](person:${id})` }]
    }
    throw new Unsupported(child.nodeName)
  })
}

/** Text with every character the format would read as syntax escaped */
function escapeText(text: string, table: boolean): string {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if ("\\*`~[]".includes(c)) out += `\\${c}`
    else if (c === "_" && (!isWordChar(text[i - 1]) || !isWordChar(text[i + 1]))) out += "\\_"
    else if (c === "<" && (i === text.length - 1 || /[A-Za-z/!]/.test(text[i + 1]))) out += "\\<"
    else if (c === "|" && table) out += "\\|"
    else if (c === ":" && /^\/\//.test(text.slice(i + 1)) && /https?$/i.test(text.slice(0, i))) out += "\\:"
    else out += c
  }
  return out
}

/** An in-app path as the Nerla item it opens, so a link written as `paper:<id>` reads back the same */
function hrefText(href: string): string {
  const doc = /^\/(paper|board)\/([0-9a-f-]{36})$/i.exec(href)
  if (doc && UUID.test(doc[2])) return `${doc[1].toLowerCase()}:${doc[2]}`
  const task = /^\/[^?#]*\?(?:[^#]*&)?task=([0-9a-f-]{36})(?:[&#].*)?$/i.exec(href)
  if (task && UUID.test(task[1])) return `task:${task[1]}`
  let out = href.replace(/\s/g, (space) => encodeURIComponent(space))
  if (out.split("(").length !== out.split(")").length) out = out.replace(/\(/g, "%28").replace(/\)/g, "%29")
  return out
}

const BARE = /^https?:\/\/[^\s<|`]+$/i

function inlineText(node: Y.XmlElement, table = false): string {
  // Runs with the same marks read as one, so two code runs never touch
  const list = pieces(node).reduce<Piece[]>((all, piece) => {
    const last = all.at(-1)
    if (last && "text" in last && "text" in piece && last.keys.join() === piece.keys.join())
      all[all.length - 1] = { ...last, text: last.text + piece.text }
    else all.push(piece)
    return all
  }, [])
  // Delimiters can't hold the whitespace at their edges, so it goes outside them
  const split: Piece[] = list.flatMap((piece): Piece[] => {
    if ("atom" in piece || piece.keys.includes("code") || !piece.keys.some((key) => key === "bold" || key === "italic" || key === "strike"))
      return [piece]
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(piece.text)!
    const bare = { ...piece, keys: piece.keys.filter((key) => key !== "bold" && key !== "italic" && key !== "strike") }
    return [
      ...(lead ? [{ ...bare, text: lead }] : []),
      ...(core ? [{ ...piece, text: core }] : []),
      ...(trail ? [{ ...bare, text: trail }] : []),
    ]
  })
  const has = (index: number, key: string) => {
    const piece = split[index]
    return !!piece && "keys" in piece && piece.keys.includes(key)
  }
  const spanLength = (from: number, key: string) => {
    let end = from
    while (end < split.length && ("atom" in split[end] || has(end, key))) end++
    return end - from
  }
  // Italic is a placeholder until its neighbours are known, then `_` where it can stand and `*` inside a word
  const parts: (string | number)[] = []
  const out = (text: string) => parts.push(text)
  const stack: string[] = []
  const italics: number[] = []
  const bareLinks = new Set<string>()
  const close = (key: string) => {
    if (key.startsWith("link:")) out(bareLinks.delete(key) ? "" : `](${hrefText(key.slice(5))})`)
    else if (key === "italic") parts.push(italics.pop()!)
    else out(key === "bold" ? "**" : key === "strike" ? "~~" : "</u>")
  }
  let pairs = 0
  for (let i = 0; i < split.length; i++) {
    const piece = split[i]
    if ("atom" in piece) {
      out(piece.atom)
      continue
    }
    const keys = piece.keys
    const cut = stack.findIndex((key) => !keys.includes(key))
    if (cut >= 0) while (stack.length > cut) close(stack.pop()!)
    const fresh = keys
      .filter((key) => key !== "code" && !stack.includes(key))
      .sort(
        (a, b) =>
          spanLength(i, b) - spanLength(i, a) || MARK_ORDER.indexOf(a.replace(/:.*$/, "")) - MARK_ORDER.indexOf(b.replace(/:.*$/, "")),
      )
    for (const key of fresh) {
      stack.push(key)
      if (key.startsWith("link:")) {
        const href = key.slice(5)
        const next = split[i + 1]
        const alone =
          !has(i + 1, key) &&
          (!next ||
            ("atom" in next
              ? next.atom === "<br>"
              : !next.keys.some((other) => other === "code" || other.startsWith("link:")) && /^\s/.test(next.text)))
        if (alone && piece.text === href && BARE.test(href) && bareUrl(href, 0) === href) bareLinks.add(key)
        else out("[")
      } else if (key === "italic") {
        italics.push(pairs)
        parts.push(pairs++)
      } else out(key === "bold" ? "**" : key === "strike" ? "~~" : "<u>")
    }
    if (keys.includes("code")) {
      const longest = Math.max(0, ...(piece.text.match(/`+/g) ?? []).map((ticks) => ticks.length))
      const fence = "`".repeat(longest + 1)
      const pad =
        piece.text.startsWith("`") ||
        piece.text.endsWith("`") ||
        (piece.text.startsWith(" ") && piece.text.endsWith(" ") && piece.text.trim())
          ? " "
          : ""
      out(`${fence}${pad}${table ? piece.text.replace(/\|/g, "\\|") : piece.text}${pad}${fence}`)
    } else if (stack.some((key) => bareLinks.has(key))) out(piece.text)
    else out(escapeText(piece.text, table))
  }
  while (stack.length) close(stack.pop()!)
  const chosen = new Map<number, string>()
  let text = ""
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (typeof part === "string") {
      text += part
      continue
    }
    let mark = chosen.get(part)
    if (mark === undefined) {
      const after = parts.slice(parts.indexOf(part, i + 1) + 1).find((next) => next !== "")
      const outside = typeof after === "number" ? "_" : after?.[0]
      mark = !isWordChar(text.at(-1)) && !isWordChar(outside) ? "_" : "*"
      chosen.set(part, mark)
    }
    text += mark
  }
  return text
}

/** A paragraph's text with whatever would start another kind of block escaped */
function lineStart(text: string): string {
  const at = text.length - text.trimStart().length
  const rest = text.slice(at)
  const ordered = /^(\d{1,9})([.)])(\s|$)/.exec(rest)
  if (ordered) return `${text.slice(0, at)}${ordered[1]}\\${rest.slice(ordered[1].length)}`
  if (/^(#|>|\||!\[|[-+](\s|$)|-{3,}$)/.test(rest)) return `${text.slice(0, at)}\\${rest}`
  return text
}

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")

/** Task ids the reader can't open, read the way the paper's Hidden task chip shows them */
type Hidden = ReadonlySet<string>
const NONE_HIDDEN: Hidden = new Set()

function itemText(list: Y.XmlElement, item: Y.XmlElement, hidden: Hidden): string {
  if (item.nodeName !== (list.nodeName === "taskList" ? "taskItem" : "listItem")) throw new Unsupported(item.nodeName)
  const index = elements(list).indexOf(item)
  const [first, ...rest] = item.toArray()
  if (!(first instanceof Y.XmlElement) || first.nodeName !== "paragraph") throw new Unsupported(item.nodeName)
  for (const child of rest)
    if (!(child instanceof Y.XmlElement) || !LISTS.has(child.nodeName))
      throw new Unsupported(child instanceof Y.XmlElement ? child.nodeName : item.nodeName)
  let head = inlineText(first)
  let marker = "- "
  if (list.nodeName === "orderedList") marker = `${(Number(list.getAttribute("start")) || 1) + index}. `
  else if (list.nodeName === "taskList") {
    marker = `- [${(item.getAttribute("checked") as unknown) === true ? "x" : " "}] `
    const taskId = item.getAttribute("taskId")
    if (typeof taskId === "string" && taskId)
      head = `[${hidden.has(taskId.toLowerCase()) ? `${HIDDEN_TASK}${head}` : head}](task:${taskId})`
  }
  return [marker + head, ...(rest as Y.XmlElement[]).map((child) => indent(blockText(child, hidden)))].join("\n").replace(/ +$/gm, "")
}

function cellText(cell: Y.XmlElement, header: boolean): string {
  if (cell.nodeName !== (header ? "tableHeader" : "tableCell")) throw new Unsupported(cell.nodeName)
  for (const span of ["colspan", "rowspan"]) {
    const value = cell.getAttribute(span)
    if (value !== undefined && value !== null && Number(value) !== 1) throw new Unsupported(cell.nodeName)
  }
  const children = cell.toArray()
  if (children.length !== 1 || !(children[0] instanceof Y.XmlElement) || children[0].nodeName !== "paragraph")
    throw new Unsupported(cell.nodeName)
  return inlineText(children[0], true)
}

function tableText(table: Y.XmlElement): string {
  const rows = elements(table)
  if (!rows.length || rows.some((row) => row.nodeName !== "tableRow")) throw new Unsupported("table")
  const cells = rows.map((row, index) => elements(row).map((cell) => cellText(cell, index === 0)))
  if (cells.some((row) => row.length !== cells[0].length) || !cells[0].length) throw new Unsupported("table")
  const line = (row: string[]) => `| ${row.join(" | ")} |`
  return [line(cells[0]), line(cells[0].map(() => "---")), ...cells.slice(1).map(line)].join("\n")
}

function blockText(block: Y.XmlElement, hidden: Hidden = NONE_HIDDEN): string {
  switch (block.nodeName) {
    case "paragraph":
      return lineStart(inlineText(block))
    case "heading": {
      const level = Number(block.getAttribute("level"))
      if (!(level >= 1 && level <= 3)) throw new Unsupported("heading")
      return `${"#".repeat(level)} ${inlineText(block)}`.trimEnd()
    }
    case "blockquote":
      return elements(block)
        .map((child) => blockText(child, hidden).replace(/^/gm, "> ").replace(/^> $/gm, ">"))
        .join("\n")
    case "codeBlock": {
      const code = block
        .toArray()
        .map((child) => {
          if (!(child instanceof Y.XmlText)) throw new Unsupported("codeBlock")
          return (child.toDelta() as { insert?: unknown }[]).map((op) => (typeof op.insert === "string" ? op.insert : "")).join("")
        })
        .join("")
      const longest = Math.max(0, ...(code.match(/^\s*`+/gm) ?? []).map((ticks) => ticks.trim().length))
      const fence = "`".repeat(Math.max(3, longest + 1))
      const language = String(block.getAttribute("language") ?? "").replace(/[\s`]/g, "")
      return `${fence}${language}\n${code}\n${fence}`
    }
    case "horizontalRule":
      return "---"
    case "bulletList":
    case "orderedList":
    case "taskList":
      return elements(block)
        .map((item) => itemText(block, item, hidden))
        .join("\n")
    case "table":
      return tableText(block)
    case "image": {
      const fileId = block.getAttribute("fileId")
      if (typeof fileId !== "string" || !fileId) throw new Unsupported("image")
      return `![${escapeText(String(block.getAttribute("alt") ?? ""), false)}](file:${fileId})`
    }
    case "boardBlock": {
      const boardId = block.getAttribute("boardId")
      if (typeof boardId !== "string" || !/^[\w.-]{1,64}$/.test(boardId)) throw new Unsupported("boardBlock")
      return `![board](drawn:${boardId})`
    }
    case "boardLink": {
      const fileId = block.getAttribute("fileId")
      if (typeof fileId !== "string" || !fileId) throw new Unsupported("boardLink")
      return `![board](board:${fileId})`
    }
    default:
      throw new Unsupported(block.nodeName)
  }
}

function readUnit(unit: Unit, hidden: Hidden = NONE_HIDDEN): string {
  return unit.item ? itemText(unit.block, unit.item, hidden) : blockText(unit.block, hidden)
}

/** One unit in the format, or `[unsupported: {node}]` when it holds something the format can't express */
export function unitText(unit: Unit, hidden: Hidden = NONE_HIDDEN): string {
  try {
    return readUnit(unit, hidden)
  } catch (error) {
    if (error instanceof Unsupported) return `[unsupported: ${error.node}]`
    throw error
  }
}

/** Whether the unit reads back without losing anything, so a replace may cover it */
export function unitSupported(unit: Unit): boolean {
  try {
    readUnit(unit)
    return true
  } catch (error) {
    if (error instanceof Unsupported) return false
    throw error
  }
}

/** The paper as one string per unit, in the format */
export const docToText = (doc: Y.Doc, hidden: Hidden = NONE_HIDDEN): string[] => unitsOf(doc).map((unit) => unitText(unit, hidden))

/** A list line's own words, without marks, as a task's title */
export function lineText(item: Y.XmlElement): string {
  const first = item.toArray()[0]
  if (!(first instanceof Y.XmlElement)) return ""
  return first
    .toArray()
    .map((child) => {
      if (child instanceof Y.XmlText)
        return (child.toDelta() as { insert?: unknown }[]).map((op) => (typeof op.insert === "string" ? op.insert : "")).join("")
      if (child instanceof Y.XmlElement && child.nodeName === "mention") return `@${child.getAttribute("label") ?? "someone"}`
      return " "
    })
    .join("")
    .trim()
}

const ITEM_HREF = /^(task|paper|board|project|file):[0-9a-f-]{36}$/

/**
 * What the units already hold, so a replace keeps it even where the asker can't open it now: task lines with their
 * text, links at their stored address, mentions, images and boards shown
 */
export function heldRefs(units: Unit[]): Omit<Resolved, "drawn"> {
  const held = {
    people: new Map<string, string>(),
    tasks: new Map<string, { title: string }>(),
    links: new Map<string, string>(),
    hrefs: new Map<string, string>(),
    images: new Map<string, string>(),
    boards: new Set<string>(),
  }
  const walk = (node: Y.XmlElement) => {
    const attr = (key: string) => {
      const value = node.getAttribute(key) as unknown
      return typeof value === "string" && value ? value : null
    }
    const id = attr("id")
    const taskId = attr("taskId")
    const fileId = attr("fileId")
    if (node.nodeName === "mention" && id) held.people.set(id, attr("label") ?? "someone")
    if (node.nodeName === "taskItem" && taskId) held.tasks.set(taskId, { title: lineText(node) })
    if (node.nodeName === "image" && fileId) held.images.set(fileId, fileId)
    if (node.nodeName === "boardLink" && fileId) held.boards.add(fileId)
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) walk(child)
      else if (child instanceof Y.XmlText) {
        for (const op of child.toDelta() as { attributes?: { link?: { href?: unknown } } }[]) {
          const href = op.attributes?.link?.href
          if (typeof href !== "string" || !href) continue
          const written = hrefText(href)
          if (ITEM_HREF.test(written)) held.links.set(written, href)
          else held.hrefs.set(written, href)
        }
      }
    }
  }
  for (const unit of units) walk(unit.item ?? unit.block)
  return held
}
