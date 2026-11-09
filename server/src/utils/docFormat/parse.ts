import {
  bareUrl,
  ITEM_KINDS,
  isSpace,
  isWordChar,
  PUNCT,
  REASONS,
  sameMarks,
  TABLE_CELLS_MAX,
  TABLE_REFUSAL,
  TABLE_ROWS_MAX,
  MENTIONS_MAX,
  IMAGES_MAX,
  unescape,
  HIDDEN_TASK,
  withMark,
  type DocNode,
  type Inline,
  type ItemKind,
  type ListItem,
  type Mark,
  type Ref,
} from "./types"
import { UUID } from "../uuid"

type Delim = { k: "delim"; ch: "*" | "_" | "~"; n: number; orig: number; open: boolean; close: boolean }
type Tok =
  | { k: "text"; text: string; reason?: string }
  | Delim
  | { k: "node"; node: Inline }
  | {
      k: "group"
      mark?: Mark
      item?: { kind: ItemKind; id: string; raw: string }
      other?: { href: string; raw: string; reason: string }
      children: Tok[]
      paired?: boolean
    }

/** The `[text](href)` starting at `at`, with balanced brackets and parentheses */
function linkAt(s: string, at: number): { text: string; href: string; end: number } | null {
  let depth = 0
  let i = at
  for (; i < s.length; i++) {
    if (s[i] === "\\") i++
    else if (s[i] === "`") {
      const run = /^`+/.exec(s.slice(i))![0]
      const close = s.indexOf(run, i + run.length)
      if (close > 0) i = close + run.length - 1
    } else if (s[i] === "[") depth++
    else if (s[i] === "]" && --depth === 0) break
  }
  if (i >= s.length || s[i + 1] !== "(") return null
  const text = s.slice(at + 1, i)
  let j = i + 2
  if (s[j] === "<") {
    const close = s.indexOf(">", j)
    if (close < 0 || s[close + 1] !== ")") return null
    return { text, href: s.slice(j + 1, close), end: close + 2 }
  }
  let parens = 0
  for (; j < s.length; j++) {
    if (/\s/.test(s[j])) return null
    if (s[j] === "\\") j++
    else if (s[j] === "(") parens++
    else if (s[j] === ")") {
      if (parens === 0) break
      parens--
    }
  }
  if (j >= s.length) return null
  return { text, href: s.slice(i + 2, j), end: j + 1 }
}

/** The `</u>` closing the `<u>` whose content starts at `from` */
function underlineClose(s: string, from: number): number {
  let depth = 1
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") i++
    else if (/^<u>/i.test(s.slice(i, i + 3))) depth++
    else if (/^<\/u>/i.test(s.slice(i, i + 4)) && --depth === 0) return i
  }
  return -1
}

type Target = { web: string } | { item: { kind: ItemKind; id: string } } | { reason: string }

function linkTarget(href: string): Target {
  if (/^(https?:\/\/\S+|mailto:\S+)$/i.test(href) || /^\/(?!\/)\S*$/.test(href)) return { web: href }
  const item = /^([a-z]+):(.*)$/i.exec(href)
  const kind = item?.[1].toLowerCase()
  if (item && kind && ITEM_KINDS.has(kind)) {
    return UUID.test(item[2]) ? { item: { kind: kind as ItemKind, id: item[2].toLowerCase() } } : { reason: REASONS.notAnId(item[2]) }
  }
  return { reason: kind === "person" ? REASONS.personLink : REASONS.link }
}

function tokenize(s: string, line: number, links: boolean): Tok[] {
  const toks: Tok[] = []
  let buf = ""
  const flush = () => {
    if (buf) toks.push({ k: "text", text: buf })
    buf = ""
  }
  const literal = (text: string, reason?: string) => {
    flush()
    toks.push(reason ? { k: "text", text, reason } : { k: "text", text })
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      buf += s[i + 1]
      i += 2
      continue
    }
    if (c === "`") {
      const run = /^`+/.exec(s.slice(i))![0]
      let close = s.indexOf(run, i + run.length)
      while (close >= 0 && s[close + run.length] === "`") close = s.indexOf(run, close + run.length + 1)
      if (close < 0) {
        buf += run
        i += run.length
        continue
      }
      let code = s.slice(i + run.length, close)
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1)
      flush()
      toks.push({ k: "node", node: { text: code, marks: [{ type: "code" }] } })
      i = close + run.length
      continue
    }
    if (c === "*" || c === "_" || c === "~") {
      let j = i
      while (s[j] === c) j++
      const before = s[i - 1]
      const after = s[j]
      const left = !isSpace(after)
      const right = !isSpace(before)
      flush()
      toks.push({
        k: "delim",
        ch: c,
        n: j - i,
        orig: j - i,
        open: c === "_" ? left && !isWordChar(before) : left,
        close: c === "_" ? right && !isWordChar(after) : right,
      })
      i = j
      continue
    }
    if (c === "<") {
      const rest = s.slice(i)
      const br = /^<br\s*\/?>/i.exec(rest)
      if (br) {
        flush()
        toks.push({ k: "node", node: { br: true } })
        i += br[0].length
        continue
      }
      if (/^<u>/i.test(rest)) {
        const end = underlineClose(s, i + 3)
        if (end >= 0) {
          flush()
          toks.push({ k: "group", mark: { type: "underline" }, children: tokenize(s.slice(i + 3, end), line, links) })
          i = end + 4
        } else {
          literal(s.slice(i, i + 3), REASONS.underline)
          i += 3
        }
        continue
      }
      const tag = /^<\/?[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?\/?>/.exec(rest)
      if (tag) {
        literal(tag[0], REASONS.tag(tag[0]))
        i += tag[0].length
        continue
      }
    }
    if (c === "@" && s[i + 1] === "[") {
      const link = linkAt(s, i + 1)
      if (link && /^person:/i.test(link.href)) {
        const raw = s.slice(i, link.end)
        const id = link.href.slice("person:".length)
        if (UUID.test(id)) {
          flush()
          toks.push({ k: "node", node: { mention: id.toLowerCase(), label: unescape(link.text), raw, line } })
        } else literal(raw, REASONS.notAnId(id))
        i = link.end
        continue
      }
    }
    if (links && c === "[") {
      const link = linkAt(s, i)
      if (link) {
        const raw = s.slice(i, link.end)
        const target = linkTarget(link.href)
        flush()
        if ("reason" in target)
          toks.push({ k: "group", other: { href: link.href, raw, reason: target.reason }, children: tokenize(link.text, line, false) })
        else if ("web" in target)
          toks.push({ k: "group", mark: { type: "link", href: target.web }, children: tokenize(link.text, line, false) })
        else toks.push({ k: "group", item: { ...target.item, raw }, children: tokenize(link.text, line, false) })
        i = link.end
        continue
      }
    }
    if (links && (c === "h" || c === "H")) {
      const url = bareUrl(s, i)
      if (url) {
        flush()
        toks.push({ k: "group", mark: { type: "link", href: url }, children: [{ k: "text", text: url }] })
        i += url.length
        continue
      }
    }
    buf += c
    i++
  }
  flush()
  return toks
}

/** Pairs `*`, `_` and `~~` runs into marks, as CommonMark does */
function emphasis(toks: Tok[]): Tok[] {
  let i = 0
  while (i < toks.length) {
    const closer = toks[i]
    if (closer.k !== "delim" || !closer.close || closer.n === 0) {
      i++
      continue
    }
    let at = -1
    for (let j = i - 1; j >= 0; j--) {
      const opener = toks[j]
      if (opener.k !== "delim" || opener.ch !== closer.ch || !opener.open || opener.n === 0) continue
      if (closer.ch === "~" && (opener.n < 2 || closer.n < 2)) continue
      const either = closer.open || opener.close
      if (closer.ch !== "~" && either && (opener.orig + closer.orig) % 3 === 0 && !(opener.orig % 3 === 0 && closer.orig % 3 === 0))
        continue
      at = j
      break
    }
    if (at < 0) {
      i++
      continue
    }
    const opener = toks[at] as Delim
    const use = closer.ch === "~" || (opener.n >= 2 && closer.n >= 2) ? 2 : 1
    const mark: Mark = { type: closer.ch === "~" ? "strike" : use === 2 ? "bold" : "italic" }
    opener.n -= use
    closer.n -= use
    toks.splice(at + 1, i - at - 1, { k: "group", mark, children: toks.slice(at + 1, i), paired: true })
    i = at + 2
  }
  return toks
}

function flatten(toks: Tok[], marks: Mark[], line: number): Inline[] {
  const out: Inline[] = []
  const push = (inline: Inline) => {
    const last = out.at(-1)
    if (last && "text" in last && "text" in inline && !last.reason && !inline.reason && sameMarks(last.marks, inline.marks)) {
      out[out.length - 1] = { text: last.text + inline.text, marks: last.marks }
    } else out.push(inline)
  }
  for (const tok of toks) {
    if (tok.k === "text") push(tok.reason ? { text: tok.text, marks, reason: tok.reason, line } : { text: tok.text, marks })
    else if (tok.k === "delim") {
      if (tok.n) push({ text: tok.ch.repeat(tok.n), marks })
    } else if (tok.k === "node") push(tok.node)
    else {
      // A pair of delimiters holds what was already paired inside it
      const children = tok.paired ? tok.children : emphasis(tok.children)
      if (tok.other)
        out.push({
          otherLink: tok.other.href,
          inline: flatten(children, marks, line),
          raw: tok.other.raw,
          marks,
          line,
          reason: tok.other.reason,
        })
      else if (tok.item)
        out.push({
          itemLink: { kind: tok.item.kind, id: tok.item.id },
          inline: flatten(children, marks, line),
          raw: tok.item.raw,
          marks,
          line,
        })
      else for (const inline of flatten(children, tok.mark ? withMark(marks, tok.mark) : marks, line)) push(inline)
    }
  }
  return out
}

const parseInline = (text: string, line: number): Inline[] => flatten(emphasis(tokenize(text, line, true)), [], line)

type Line = { text: string; line: number }

const FENCE = /^(`{3,})\s*([^`\s]*)\s*$/
const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/
const EMBED = /^!\[((?:\\.|[^\\\]])*)\]\(([^()\s]+)\)$/
const LIST_LINE = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/
const TASK_LINE = /^\[((?:\\.|[^\\\]])*)\]\(task:([^()\s]+)\)$/i

const textNode = (text: string, line: number, reason: string): DocNode => ({ type: "text", text, line, reason })

/** A pipe table row's cells, split on the `|` that aren't escaped */
function rowCells(row: string): string[] {
  let body = row.trim()
  if (body.startsWith("|")) body = body.slice(1)
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1)
  const cells: string[] = []
  let cell = ""
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "`") {
      // A code span keeps its backslashes, and only its `\|` stands for a pipe
      const run = /^`+/.exec(body.slice(i))![0]
      const close = body.indexOf(run, i + run.length)
      const span = close < 0 ? run : body.slice(i, close + run.length)
      cell += span.replace(/\\\|/g, "|")
      i += span.length - 1
    } else if (body[i] === "\\" && i + 1 < body.length) {
      cell += body[i + 1] === "|" ? "|" : `\\${body[i + 1]}`
      i++
    } else if (body[i] === "|") {
      cells.push(cell.trim())
      cell = ""
    } else cell += body[i]
  }
  cells.push(cell.trim())
  return cells
}

function embedNode(match: RegExpExecArray, raw: string, line: number): DocNode {
  const alt = unescape(match[1])
  const target = match[2]
  const [, kind = "", id = ""] = /^([a-z]+):(.*)$/i.exec(target) ?? []
  switch (kind.toLowerCase()) {
    case "file":
      return UUID.test(id) ? { type: "image", fileId: id.toLowerCase(), alt, raw, line } : textNode(raw, line, REASONS.notAnId(id))
    case "board":
      if (id.toLowerCase() === "new") return { type: "boardBlock", new: true }
      return UUID.test(id) ? { type: "boardLink", fileId: id.toLowerCase(), raw, line } : textNode(raw, line, REASONS.notAnId(id))
    case "drawn":
      return /^[\w.-]{1,64}$/.test(id) ? { type: "boardBlock", boardId: id, raw, line } : textNode(raw, line, REASONS.notAnId(id))
    case "http":
    case "https":
    case "data":
      return textNode(raw, line, REASONS.webImage)
    default:
      return textNode(raw, line, REASONS.embed)
  }
}

function listItemOf(
  marker: string,
  rest: string,
  line: number,
): { list: "bulletList" | "orderedList" | "taskList"; start: number; item: ListItem } {
  const item = (inline: Inline[]): ListItem => ({ type: "listItem", checked: false, task: null, line, inline, children: [] })
  if (/^\d/.test(marker)) return { list: "orderedList", start: Number.parseInt(marker, 10), item: item(parseInline(rest, line)) }
  const box = /^\[([ xX])\](?:\s+(.*))?$/.exec(rest)
  if (!box) return { list: "bulletList", start: 1, item: item(parseInline(rest, line)) }
  let text = box[2] ?? ""
  let task = TASK_LINE.exec(text)
  // read_doc marks a task the reader can't open, and the mark never goes back into the paper
  if (task && task[1].startsWith(HIDDEN_TASK)) {
    text = `[${task[1].slice(HIDDEN_TASK.length)}](task:${task[2]})`
    task = TASK_LINE.exec(text)
  }
  return {
    list: "taskList",
    start: 1,
    item: {
      type: "taskItem",
      checked: box[1] !== " ",
      task: task && UUID.test(task[2]) ? { id: task[2].toLowerCase(), raw: text } : null,
      line,
      inline: parseInline(text, line),
      children: [],
    },
  }
}

type ListNode = Extract<DocNode, { items: ListItem[] }>

function parseLines(lines: Line[]): DocNode[] {
  const out: DocNode[] = []
  // The lists open at each depth, with the item the next deeper line goes in
  let open: { node: ListNode; last: ListItem }[] = []
  const block = (node: DocNode) => {
    out.push(node)
    open = []
  }
  let i = 0
  while (i < lines.length) {
    const { text, line } = lines[i]
    const body = text.trimStart()
    if (!body) {
      i++
      continue
    }
    const fence = FENCE.exec(body)
    if (fence) {
      const ticks = fence[1].length
      const closes = (other: string) => {
        const bare = other.trim()
        return bare.length >= ticks && /^`+$/.test(bare)
      }
      const end = lines.findIndex((other, at) => at > i && closes(other.text))
      if (end < 0) {
        block(textNode(text, line, REASONS.fence))
        i++
        continue
      }
      block({
        type: "codeBlock",
        language: fence[2] || null,
        code: lines
          .slice(i + 1, end)
          .map((one) => one.text)
          .join("\n"),
      })
      i = end + 1
      continue
    }
    if (body.startsWith(">")) {
      const inner: Line[] = []
      for (; i < lines.length && lines[i].text.trimStart().startsWith(">"); i++) {
        inner.push({ text: lines[i].text.trimStart().replace(/^> ?/, ""), line: lines[i].line })
      }
      const children = parseLines(inner)
      block({ type: "blockquote", children: children.length ? children : [{ type: "paragraph", inline: [] }] })
      continue
    }
    if (/^-{3,}$/.test(body)) {
      block({ type: "horizontalRule" })
      i++
      continue
    }
    if (body.startsWith("|")) {
      if (i + 1 < lines.length && SEPARATOR.test(lines[i + 1].text.trim())) {
        const header = rowCells(body).map((cell) => parseInline(cell, line))
        const rows: Inline[][][] = []
        for (i += 2; i < lines.length && lines[i].text.trimStart().startsWith("|"); i++) {
          const at = lines[i].line
          rows.push(rowCells(lines[i].text).map((cell) => parseInline(cell, at)))
        }
        const width = Math.max(header.length, ...rows.map((row) => row.length))
        const pad = (row: Inline[][]) => [...row, ...Array.from({ length: width - row.length }, () => [])]
        block({ type: "table", header: pad(header), rows: rows.map(pad) })
        continue
      }
      if (body.length > 1 && body.endsWith("|")) {
        block(textNode(text, line, REASONS.table))
        i++
        continue
      }
    }
    const embed = EMBED.exec(body)
    if (embed) {
      block(embedNode(embed, body, line))
      i++
      continue
    }
    const heading = /^(#{1,6})(?:[ \t](.*))?$/.exec(body)
    if (heading) {
      const level = heading[1].length
      block(level <= 3 ? { type: "heading", level, inline: parseInline(heading[2] ?? "", line) } : textNode(text, line, REASONS.heading))
      i++
      continue
    }
    const listLine = LIST_LINE.exec(text)
    if (listLine) {
      const { list, start, item } = listItemOf(listLine[2], listLine[3] ?? "", line)
      const depth = Math.min(Math.floor(listLine[1].replace(/\t/g, "  ").length / 2), open.length)
      const fresh = (): ListNode => (list === "orderedList" ? { type: list, start, items: [item] } : { type: list, items: [item] })
      if (depth < open.length && open[depth].node.type === list) {
        open[depth].node.items.push(item)
        open[depth].last = item
        open = open.slice(0, depth + 1)
      } else {
        const node = fresh()
        if (depth === 0) out.push(node)
        else open[depth - 1].last.children.push(node)
        open = [...open.slice(0, depth), { node, last: item }]
      }
      i++
      continue
    }
    block({ type: "paragraph", inline: parseInline(text, line) })
    i++
  }
  return out
}

function inlineRefs(inline: Inline[], refs: Ref[]) {
  for (const one of inline) {
    if ("mention" in one) refs.push({ kind: "person", id: one.mention })
    else if ("otherLink" in one) inlineRefs(one.inline, refs)
    else if ("itemLink" in one) {
      refs.push(one.itemLink)
      inlineRefs(one.inline, refs)
    }
  }
}

function nodeRefs(nodes: DocNode[], refs: Ref[]) {
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
      case "heading":
        inlineRefs(node.inline, refs)
        break
      case "blockquote":
        nodeRefs(node.children, refs)
        break
      case "bulletList":
      case "orderedList":
      case "taskList":
        for (const item of node.items) {
          if (item.task) refs.push({ kind: "task", id: item.task.id })
          inlineRefs(item.inline, refs)
          nodeRefs(item.children, refs)
        }
        break
      case "table":
        for (const cell of [...node.header, ...node.rows.flat()]) inlineRefs(cell, refs)
        break
      case "image":
        refs.push({ kind: "image", id: node.fileId })
        break
      case "boardLink":
        refs.push({ kind: "board", id: node.fileId })
        break
    }
  }
}

/** The text as blocks, and every Nerla id it names */
export function parseDocText(text: string): { nodes: DocNode[]; refs: Ref[] } {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((raw, i) => ({ text: raw.replace(/^\s*\[b\d+\]\s?/, "").trimEnd(), line: i + 1 }))
  const nodes = parseLines(lines)
  const refs: Ref[] = []
  nodeRefs(nodes, refs)
  const seen = new Set<string>()
  return { nodes, refs: refs.filter((ref) => !seen.has(`${ref.kind}:${ref.id}`) && !!seen.add(`${ref.kind}:${ref.id}`)) }
}

/** The caps on one write, as the refusal for the first one passed */
export function formatRefusal(nodes: DocNode[]): string | null {
  let mentions = 0
  let images = 0
  let table = false
  const inline = (list: Inline[]) => {
    for (const one of list) {
      if ("mention" in one) mentions++
      else if ("itemLink" in one || "otherLink" in one) inline(one.inline)
    }
  }
  const walk = (list: DocNode[]) => {
    for (const node of list) {
      if (node.type === "paragraph" || node.type === "heading") inline(node.inline)
      else if (node.type === "blockquote") walk(node.children)
      else if (node.type === "image") images++
      else if (node.type === "table") {
        if (node.rows.length + 1 > TABLE_ROWS_MAX || node.header.length > TABLE_CELLS_MAX) table = true
        for (const cell of [...node.header, ...node.rows.flat()]) inline(cell)
      } else if ("items" in node) {
        for (const item of node.items) {
          inline(item.inline)
          walk(item.children)
        }
      }
    }
  }
  walk(nodes)
  if (table) return TABLE_REFUSAL
  if (mentions > MENTIONS_MAX) return `A write can mention at most ${MENTIONS_MAX} people`
  if (images > IMAGES_MAX) return `A write can add at most ${IMAGES_MAX} images`
  return null
}
