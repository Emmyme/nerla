export const PREF_MAX_LINES = 30
export const PREF_MAX_CHARS = 300

/** A line as the server saves it, with its spaces folded */
const foldLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** Whether saving would change anything, since spaces the server folds away change nothing */
export function linesChanged(a: string[], b: string[]): boolean {
  return a.length !== b.length || a.some((line, index) => foldLine(line) !== foldLine(b[index]))
}
