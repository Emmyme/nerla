import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = __dirname

/** Every non-test source file under src, apart from db/ where the schema lives */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return relative(SRC, path) === "db" ? [] : walk(path)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : []
  })
}

const sources = walk(SRC).map((path) => ({ file: relative(SRC, path), text: readFileSync(path, "utf8") }))

export const OPEN = "([{"
export const CLOSE = ")]}"

/** The text inside the parentheses that open at `start` */
export function argumentAt(text: string, start: number): string {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (OPEN.includes(text[i])) depth++
    else if (CLOSE.includes(text[i]) && --depth === 0) return text.slice(start + 1, i)
  }
  return text.slice(start + 1)
}

/** Where the statement around `index` begins and ends, comments before it included */
export function statementBounds(text: string, index: number): [number, number] {
  let begin = index
  for (let depth = 0; begin > 0; begin--) {
    const c = text[begin - 1]
    if (c === "}" && depth === 0) break
    if (CLOSE.includes(c)) depth++
    else if (OPEN.includes(c) && --depth < 0) break
    else if (c === ";" && depth === 0) break
  }
  let end = index
  for (let depth = 0; end < text.length; end++) {
    const c = text[end]
    if (OPEN.includes(c)) depth++
    else if (CLOSE.includes(c) && --depth < 0) break
    else if (c === ";" && depth === 0) break
  }
  return [begin, end]
}

export const statementAt = (text: string, index: number) => text.slice(...statementBounds(text, index))

export const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length

/** `file:line` for every problem `check` finds, over every source file but `skip` */
export const across = (check: (text: string) => number[], skip?: string) =>
  sources.filter(({ file }) => file !== skip).flatMap(({ file, text }) => check(text).map((line) => `${file}:${line}`))
