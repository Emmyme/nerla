/** A piece of a line with its marks. Model text only ever becomes these, never markup. `href` is only ever a Nerla path */
export type AiRun = { text: string; bold?: true; italic?: true; code?: true; href?: string }

type AiBlock =
  | { type: "paragraph"; runs: AiRun[] }
  | { type: "heading"; runs: AiRun[] }
  | { type: "list"; ordered: boolean; start: number; items: AiRun[][] }
  | { type: "code"; text: string }

type Marks = Omit<AiRun, "text" | "href">

const FENCE = /^\s*(```|~~~)/
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/

const INLINE =
  /`([^`\n]+)`|!\[([^\]\n]*)\]\(([^)\s]+)[^)\n]*\)|\[([^\]\n]+)\]\(([^)\s]+)[^)\n]*\)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=[^\s*])([\s\S]*?[^\s*])\*|_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])|(?<![\w/.:-])(\/(?:paper|board)\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?![\w-])/gu

/** A paper, board or project in Nerla, which opens inside the app */
const NERLA_PATH =
  /^\/(?:(?:paper|board)\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|project\/[a-z0-9]+(?:-[a-z0-9]+)*)$/

/** An underscore right after a letter, digit or underscore is inside a word, as in snake_case */
const IN_WORD = /[\p{L}\p{N}_]$/u

/** Where a link goes, so the reader sees it without anything being fetched */
function domainOf(href: string): string {
  try {
    const host = new URL(href).hostname.replace(/^www\./, "")
    return host || href
  } catch {
    return href
  }
}

function merge(runs: AiRun[]): AiRun[] {
  const out: AiRun[] = []
  for (const run of runs) {
    if (!run.text) continue
    const last = out[out.length - 1]
    if (last && !last.href && !run.href && !!last.bold === !!run.bold && !!last.italic === !!run.italic && !!last.code === !!run.code)
      last.text += run.text
    else out.push({ ...run })
  }
  return out
}

function withMarks(text: string, marks: Marks): AiRun {
  return { text, ...marks }
}

function inline(text: string, marks: Marks): AiRun[] {
  const runs: AiRun[] = []
  let at = 0
  const pattern = new RegExp(INLINE)
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const index = match.index
    if (match[9] !== undefined && IN_WORD.test(text.slice(Math.max(0, index - 2), index))) {
      pattern.lastIndex = index + 1
      continue
    }
    if (index > at) runs.push(withMarks(text.slice(at, index), marks))
    const [, code, alt, imageHref, label, href, bold, boldAlt, italic, italicAlt, path] = match
    if (code !== undefined) runs.push(withMarks(code, { ...marks, code: true }))
    else if (path !== undefined) runs.push({ ...marks, text: path.startsWith("/board/") ? "Open the board" : "Open the paper", href: path })
    else if (href !== undefined && NERLA_PATH.test(href)) runs.push({ ...marks, text: label, href })
    else if (imageHref !== undefined) runs.push(withMarks(`${alt || "Image"} (${domainOf(imageHref)})`, marks))
    else if (href !== undefined) runs.push(...inline(label, marks), withMarks(` (${domainOf(href)})`, marks))
    else if ((bold ?? boldAlt) !== undefined) runs.push(...inline(bold ?? boldAlt, { ...marks, bold: true }))
    else runs.push(...inline(italic ?? italicAlt, { ...marks, italic: true }))
    at = index + match[0].length
  }
  if (at < text.length) runs.push(withMarks(text.slice(at), marks))
  return runs
}

const parseInline = (text: string): AiRun[] => merge(inline(text, {}))

/** The model's markdown read into a few plain blocks. Anything else stays as text */
export function parseAiMarkdown(text: string): AiBlock[] {
  const blocks: AiBlock[] = []
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  let paragraph: string[] = []
  let list: { ordered: boolean; start: number; items: string[] } | null = null

  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", runs: parseInline(paragraph.join("\n")) })
    paragraph = []
  }
  const endList = () => {
    if (list) blocks.push({ type: "list", ordered: list.ordered, start: list.start, items: list.items.map(parseInline) })
    list = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) {
      endParagraph()
      endList()
      const fence = line.trim().slice(0, 3)
      const code: string[] = []
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) code.push(lines[i])
      blocks.push({ type: "code", text: code.join("\n") })
      continue
    }
    if (!line.trim()) {
      endParagraph()
      endList()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      endParagraph()
      endList()
      blocks.push({ type: "heading", runs: parseInline(heading[1]) })
      continue
    }
    if (RULE.test(line)) {
      endParagraph()
      endList()
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      endParagraph()
      const ordered = !!numbered
      if (!list || list.ordered !== ordered) {
        endList()
        list = { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] }
      }
      list.items.push(bullet ? bullet[1] : numbered![2])
      continue
    }
    const current = list as { items: string[] } | null
    if (current && /^\s{2,}\S/.test(line)) {
      current.items[current.items.length - 1] += ` ${line.trim()}`
      continue
    }
    endList()
    paragraph.push(QUOTE.exec(line)?.[1] ?? line)
  }
  endParagraph()
  endList()
  return blocks
}

/** The text alone, for reading out */
export function plainText(text: string): string {
  return parseAiMarkdown(text)
    .map((block) =>
      block.type === "code"
        ? block.text
        : block.type === "list"
          ? block.items.map((runs) => runs.map((run) => run.text).join("")).join(", ")
          : block.runs.map((run) => run.text).join(""),
    )
    .join(" ")
}
