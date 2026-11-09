import type { Visibility } from "./eventVisibility"

const TASK_ID = /^([A-Za-z][A-Za-z0-9]{1,4})-(\d{1,9})$/
const ELLIPSIS = "…"

/** A query shaped like a task ID such as WEB-142. A bare number is not one */
export function parseTaskId(q: string): { key: string; number: number } | null {
  const match = TASK_ID.exec(q.trim())
  return match ? { key: match[1].toUpperCase(), number: Number(match[2]) } : null
}

/** About `width` characters of plain text around the first match, cut on whole code points */
export function snippetAround(content: string, q: string, width = 80): string {
  const chars = Array.from(content.replace(/\s+/g, " ").trim())
  if (chars.length <= width) return chars.join("")
  const lowered = chars.map((c) => c.toLowerCase())
  const offsets: number[] = []
  let length = 0
  for (const part of lowered) {
    offsets.push(length)
    length += part.length
  }
  const needle = q.trim().toLowerCase()
  const at = needle ? lowered.join("").indexOf(needle) : -1
  let start = 0
  if (at > 0) {
    let first = offsets.findIndex((offset, i) => at >= offset && at < (offsets[i + 1] ?? length))
    if (first < 0) first = 0
    const span = Array.from(needle).length
    start = Math.max(0, Math.min(first - Math.floor(Math.max(0, width - span) / 2), chars.length - width))
  }
  const end = Math.min(chars.length, start + width)
  return `${start > 0 ? ELLIPSIS : ""}${chars.slice(start, end).join("")}${end < chars.length ? ELLIPSIS : ""}`
}

/** A title may only match where the viewer would see it */
export const eventMatchable = (visibility: Visibility): boolean => visibility === "full"
