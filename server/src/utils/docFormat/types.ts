/**
 * The one text format the AI reads and writes papers in: markdown for the blocks and marks the editor has, plus a
 * few forms for Nerla's own nodes. Anything it can't express reads as `[unsupported: {node}]`, and anything written
 * it doesn't understand stays in the paper as the text that was written
 */

export type ItemKind = "task" | "paper" | "board" | "project" | "file"
export type Mark = { type: "bold" | "italic" | "underline" | "strike" | "code" } | { type: "link"; href: string }

export type Inline =
  | { text: string; marks: Mark[]; reason?: string; line?: number }
  | { mention: string; label: string; raw: string; line: number }
  | { br: true }
  /** A link to a Nerla item, which becomes a link only once the asker can open it, else stays as `raw` */
  | { itemLink: { kind: ItemKind; id: string }; inline: Inline[]; raw: string; marks: Mark[]; line: number }
  /** A link the writer takes only when the paper already held it, such as tel:, else it stays as `raw` */
  | { otherLink: string; inline: Inline[]; raw: string; marks: Mark[]; line: number; reason: string }

export type ListItem = {
  type: "listItem" | "taskItem"
  checked: boolean
  /** A task line's task, with the text it was written as */
  task: { id: string; raw: string } | null
  line: number
  inline: Inline[]
  children: DocNode[]
}

export type DocNode =
  | { type: "paragraph"; inline: Inline[] }
  | { type: "heading"; level: number; inline: Inline[] }
  | { type: "blockquote"; children: DocNode[] }
  | { type: "codeBlock"; language: string | null; code: string }
  | { type: "horizontalRule" }
  | { type: "bulletList" | "taskList"; items: ListItem[] }
  | { type: "orderedList"; start: number; items: ListItem[] }
  | { type: "table"; header: Inline[][]; rows: Inline[][][] }
  | { type: "image"; fileId: string; alt: string; raw: string; line: number }
  | { type: "boardLink"; fileId: string; raw: string; line: number }
  | { type: "boardBlock"; new: true }
  | { type: "boardBlock"; boardId: string; raw: string; line: number }
  /** A line kept as written */
  | { type: "text"; text: string; reason: string; line: number }

export type Ref = { kind: "person" | "image" | ItemKind; id: string }

/** What the asker can reach of what a text names, looked up on the server */
export type Resolved = {
  /** Users who can open the paper, by id, with their current name */
  people: ReadonlyMap<string, string>
  tasks: ReadonlyMap<string, { title: string }>
  /** `{kind}:{id}` to the item's path in Nerla */
  links: ReadonlyMap<string, string>
  /** An image file's id to the id of its copy in the paper */
  images: ReadonlyMap<string, string>
  /** Board files the asker can open */
  boards: ReadonlySet<string>
  /** Boards drawn in this paper that a write may show again */
  drawn: ReadonlySet<string>
  /** Links already in the range a replace covers, as written to the stored address */
  hrefs: ReadonlyMap<string, string>
}

export const NO_REFS: Resolved = {
  people: new Map(),
  tasks: new Map(),
  links: new Map(),
  images: new Map(),
  boards: new Set(),
  drawn: new Set(),
  hrefs: new Map(),
}

/** What a write left as text, by its line, or with no line for a change outside the text written */
export type Kept = { line: number | null; reason: string }

export const TABLE_ROWS_MAX = 50
export const TABLE_CELLS_MAX = 10
export const MENTIONS_MAX = 20
export const IMAGES_MAX = 10
export const TABLE_REFUSAL = `A table can have at most ${TABLE_ROWS_MAX} rows of ${TABLE_CELLS_MAX} cells`

/** How read_doc marks a task line the reader can't open */
export const HIDDEN_TASK = "Hidden task: "

export const ITEM_KINDS = new Set<string>(["task", "paper", "board", "project", "file"])
export const PUNCT = /[!-/:-@[-`{-~]/
export const isSpace = (char: string | undefined) => char === undefined || /\s/u.test(char)
export const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char)
export const unescape = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/g, "$1")

export const REASONS = {
  heading: "Headings go from # to ###, so this stays as text",
  link: "Links take https://, mailto:, a path in Nerla or a Nerla item such as task:<id>, so this stays as text",
  personLink: "People are mentioned as @[Name](person:<id>), so this stays as text",
  notAnId: (id: string) => `${id} isn't a Nerla id, so this stays as text`,
  tag: (tag: string) => `${tag} isn't part of the paper format, so it stays as text`,
  underline: "<u> needs a closing </u>, so it stays as text",
  webImage: "Images come from the user's Nerla files, written ![alt](file:<id>), never from the web, so this stays as text",
  embed: "Only ![alt](file:<id>), ![board](board:<id>) and ![board](board:new) go on a line of their own, so this stays as text",
  fence: "A code block needs a closing ```, so this stays as text",
  table: "A table needs a | --- | line under its header row, so this stays as text",
  item: (kind: string, id: string) => `There is no ${kind} ${id} the user can open, so this stays as text`,
  image: (id: string) => `There is no image file ${id} the user can open, so this stays as text`,
  board: (id: string) => `There is no board ${id} the user can open, so this stays as text`,
  drawn: (id: string) => `There is no board ${id} drawn in this paper to show here, so this stays as text`,
  mention: (name: string) => `${name} can't open this paper, so they can't be mentioned and this stays as text`,
}

const TRAILING = /[.,;:!?'"*_~]$/

/** A bare web address at `at`, without the punctuation that ends a sentence */
export function bareUrl(s: string, at: number): string | null {
  const found = /^https?:\/\/[^\s<`]+/i.exec(s.slice(at))
  if (!found) return null
  let url = found[0]
  for (;;) {
    const opens = url.split("(").length - 1
    const closes = url.split(")").length - 1
    if (TRAILING.test(url) || (url.endsWith(")") && closes > opens)) url = url.slice(0, -1)
    else break
  }
  return /^https?:\/\/./i.test(url) ? url : null
}

export const MARK_ORDER = ["link", "underline", "strike", "bold", "italic", "code"]
const markKey = (mark: Mark) => (mark.type === "link" ? `link:${mark.href}` : mark.type)
export const withMark = (marks: Mark[], mark: Mark) =>
  marks.some((one) => one.type === mark.type)
    ? marks
    : [...marks, mark].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type))
export const sameMarks = (a: Mark[], b: Mark[]) => a.length === b.length && a.every((mark, i) => markKey(mark) === markKey(b[i]))
