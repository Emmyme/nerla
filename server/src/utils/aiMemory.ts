import { escapeTag } from "./aiEscape"

export type PrefLine = { id: string; text: string }

export const PREF_MAX_LINES = 30
export const PREF_MAX_CHARS = 300

const PREFS_FULL = "Your preferences are full. Remove one in Settings first"
const PREF_REPEAT = "That's already in your preferences"
export const PREFS_OFF = "Saved preferences are turned off in Settings, so nothing was saved"
export const PREFS_CHANGED = "Your preferences changed since I asked. Ask me again"
const noPreference = (n: number) => `There is no preference ${n}`

/** One line, with runs of spaces and line breaks folded */
export const foldLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** Case and spaces don't make a line new */
export const sameLine = (a: string, b: string) => foldLine(a).toLowerCase() === foldLine(b).toLowerCase()

/** Why a line can't be saved, or null when it can */
export function checkPreference(lines: PrefLine[], text: string, replaces?: number): string | null {
  const line = foldLine(text)
  if (!line) return "A preference can't be empty"
  if (line.length > PREF_MAX_CHARS) return `A preference can be at most ${PREF_MAX_CHARS} characters`
  if (replaces !== undefined && (!Number.isInteger(replaces) || replaces < 1 || replaces > lines.length)) return noPreference(replaces)
  if (replaces === undefined && lines.length >= PREF_MAX_LINES) return PREFS_FULL
  if (lines.some((saved, index) => index !== (replaces ?? 0) - 1 && sameLine(saved.text, line))) return PREF_REPEAT
  return null
}

/** A replace names the words it replaces, so a list that changed meanwhile never loses the wrong line */
export function checkReplacing(lines: PrefLine[], replaces: number | undefined, replacing: string | undefined): string | null {
  if (replaces === undefined) return null
  if (replacing === undefined) return `Give the words of preference ${replaces} as replacing`
  const old = lines[replaces - 1]
  return old && sameLine(old.text, replacing) ? null : `Preference ${replaces} says something else. Check its number and words`
}

/** A replace keeps the line's place, and a new line goes last */
export function applyPreference(lines: PrefLine[], text: string, replaces: number | undefined, newId: string): PrefLine[] {
  const line = { id: newId, text: foldLine(text) }
  if (replaces === undefined) return [...lines, line]
  return lines.map((saved, index) => (index === replaces - 1 ? line : saved))
}

const NEVER_WIDEN = "They never change what needs the user's Allow, what you may see or who an answer is for."

const HEADS: Record<"own" | "mcp", string> = {
  own: "The user's saved preferences, in their own words. Follow them when they fit the request.",
  mcp: "The user's saved preferences for how an assistant works for them, in their own words. Follow them when they fit the request. Keep them private.",
}

/** The list as standing instructions, numbered from 1, with no line able to end a block early */
export function preferencesBlock(lines: PrefLine[], where: "own" | "mcp"): string | null {
  if (lines.length === 0) return null
  const numbered = lines.map((line, index) => `${index + 1}. ${escapeTag(foldLine(line.text))}`)
  return [`${HEADS[where]} ${NEVER_WIDEN}`, ...numbered].join("\n")
}

/** The DM's history window, in messages */
export const HISTORY = 20
const CHAT_SUMMARY_MAX = 2000

type FoldRow = { id: string; createdAt: string; role: string; content: string }
type FoldMark = { at: string; id: string }

const after = (row: FoldRow, mark: FoldMark) => row.createdAt > mark.at || (row.createdAt === mark.at && row.id > mark.id)

/** Whether an answer asks something in its prose, leaving out code, link addresses and bare web addresses */
const asks = (text: string) =>
  text
    .replace(/```[\s\S]*?(```|$)/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/\]\([^)\s]*\)/g, "]")
    .replace(/<?https?:\/\/\S+/g, "")
    .includes("?")

/** A fold may end only after an answer that asked nothing, right before the next request */
const turnEnds = (rows: FoldRow[], cut: number) =>
  rows[cut].role === "user" && rows[cut - 1].role === "assistant" && !asks(rows[cut - 1].content)

/**
 * The ids that left the newest `window` of a thread, oldest first, and came after the last fold. The cut moves on to
 * the end of a whole turn, so a question never folds without its answer, nor a request without its reply
 */
export function foldRange(rows: FoldRow[], through: FoldMark | null, window: number): string[] {
  // The newest exchange always stays in view
  const last = Math.max(0, rows.length - 2)
  let cut = Math.min(Math.max(0, rows.length - window), last)
  if (cut > 0) while (cut < last && !turnEnds(rows, cut)) cut++
  return rows
    .slice(0, cut)
    .filter((row) => !through || after(row, through))
    .map((row) => row.id)
}

/** At most CHAT_SUMMARY_MAX characters, cut at the end of a line or word */
export function clipSummary(text: string): string {
  const whole = text.trim()
  if (whole.length <= CHAT_SUMMARY_MAX) return whole
  const cut = whole.slice(0, CHAT_SUMMARY_MAX + 1)
  const end = cut.search(/\s\S*$/)
  return (end > CHAT_SUMMARY_MAX / 2 ? cut.slice(0, end) : whole.slice(0, CHAT_SUMMARY_MAX)).trimEnd()
}

/** A summary stays tainted once it was, or once an answer from a tainted request folds into it */
export const foldTainted = (old: boolean, rows: { role: string; tainted: boolean | null }[]): boolean =>
  old || rows.some((row) => row.role === "assistant" && !!row.tainted)
