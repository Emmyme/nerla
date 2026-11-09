/** A mention as stored, `@[userId]`, or `@[ai]` for the AI teammate. The server's `utils/mentions.ts` keeps the same pattern */
const MENTION = /@\[(ai|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi

/** How a user no longer in the workspace, or never in it, is shown */
const SOMEONE = "Someone"

/** The id the AI teammate's mention carries */
export const AI_MENTION_ID = "ai"

let aiName = "Nerla AI"

/** The AI teammate's name, which its mentions read as everywhere */
export function setAiMentionName(name: string): void {
  aiName = name
}

const nameFor = (id: string, names: MentionNames) => (id === AI_MENTION_ID ? (names.get(id) ?? aiName) : (names.get(id) ?? SOMEONE))

const WORD = /[\p{L}\p{N}_]/u
const QUERY_LENGTH = 40

export type MentionNames = ReadonlyMap<string, string>
export type MentionPerson = { id: string; name: string }
type MentionPart = { text: string; id?: undefined } | { id: string; text: string }

const mentionToken = (id: string) => `@[${id.toLowerCase()}]`

export function mentionName(person: { first_name: string | null; last_name: string | null }): string {
  return [person.first_name, person.last_name].filter(Boolean).join(" ").trim() || SOMEONE
}

/** Names by lowercased id, the first entry for a user winning */
export function namesOf(
  people: ({ id: string; first_name: string | null; last_name: string | null } | null | undefined)[],
): Map<string, string> {
  const names = new Map<string, string>()
  for (const person of people) {
    const id = person?.id.toLowerCase()
    if (person && id && !names.has(id)) names.set(id, mentionName(person))
  }
  return names
}

/** The users a text mentions, each once, as lowercased ids. The AI is left out */
export function parseMentions(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((match) => match[1].toLowerCase()))].filter((id) => id !== AI_MENTION_ID)
}

/** Every mention in order, repeats included, with the name it shows */
export function mentionedPeople(text: string, names: MentionNames): MentionPerson[] {
  return [...text.matchAll(MENTION)].map((match) => {
    const id = match[1].toLowerCase()
    return { id, name: nameFor(id, names) }
  })
}

/** The text in runs, a mention being its own run that reads "@Name" */
export function mentionParts(text: string, names: MentionNames): MentionPart[] {
  const parts: MentionPart[] = []
  let at = 0
  for (const match of text.matchAll(MENTION)) {
    if (match.index > at) parts.push({ text: text.slice(at, match.index) })
    const id = match[1].toLowerCase()
    parts.push({ id, text: `@${nameFor(id, names)}` })
    at = match.index + match[0].length
  }
  if (at < text.length || parts.length === 0) parts.push({ text: text.slice(at) })
  return parts
}

/** The text as users read it, each token as "@Name" */
export function renderMentionText(text: string, names: MentionNames): string {
  return text.replace(MENTION, (_, id: string) => `@${nameFor(id.toLowerCase(), names)}`)
}

const labelOf = (person: MentionPerson) => `@${person.name}`
const longestFirst = (people: MentionPerson[]) => [...new Set(people.map(labelOf))].sort((a, b) => b.length - a.length)

/** The label that starts at `i`, standing apart from the words around it */
function labelAt(text: string, i: number, labels: string[]): string | undefined {
  if (text[i] !== "@" || WORD.test(text[i - 1] ?? "")) return undefined
  return labels.find((label) => text.startsWith(label, i) && !WORD.test(text[i + label.length] ?? ""))
}

/** The picks a text still holds: for each name, as many as it shows, the most recent kept */
export function prunePicks(text: string, picked: MentionPerson[], others: MentionPerson[] = []): MentionPerson[] {
  const labels = longestFirst([...picked, ...others])
  const left = new Map<string, number>()
  for (let i = 0; i < text.length;) {
    const label = labelAt(text, i, labels)
    if (label) left.set(label, (left.get(label) ?? 0) + 1)
    i += label?.length ?? 1
  }
  const kept: MentionPerson[] = []
  for (const person of [...picked].reverse()) {
    const n = left.get(labelOf(person)) ?? 0
    if (n === 0) continue
    left.set(labelOf(person), n - 1)
    kept.unshift(person)
  }
  return kept
}

/**
 * The text a composer shows turned back into stored text. Each "@Name" of the users picked becomes their token,
 * in order when several share a name, and the others only stand in for names nobody picked.
 */
export function toMentionTokens(text: string, picked: MentionPerson[], others: MentionPerson[] = []): string {
  const queues = new Map<string, string[]>()
  for (const person of prunePicks(text, picked, others)) queues.set(labelOf(person), [...(queues.get(labelOf(person)) ?? []), person.id])
  for (const person of others) if (!queues.has(labelOf(person))) queues.set(labelOf(person), [person.id])
  const labels = longestFirst([...picked, ...others]).filter((label) => queues.has(label))
  let out = ""
  for (let i = 0; i < text.length;) {
    const label = labelAt(text, i, labels)
    if (!label) {
      out += text[i]
      i++
      continue
    }
    const queue = queues.get(label)!
    out += mentionToken(queue.length > 1 ? queue.shift()! : queue[0])
    i += label.length
  }
  return out
}

/** The "@" being typed before the caret, and what follows it, when the caret is in one */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(Math.max(0, caret - QUERY_LENGTH - 1), caret)
  const at = before.lastIndexOf("@")
  if (at < 0) return null
  const start = caret - before.length + at
  const query = text.slice(start + 1, caret)
  if (/[\n@]/.test(query) || /^\s/.test(query) || WORD.test(text[start - 1] ?? "")) return null
  return { start, query }
}

/** Users whose name, or a word of it, starts with what is typed */
export function matchPeople<T extends MentionPerson>(people: T[], query: string): T[] {
  const typed = query.toLowerCase()
  return people.filter((person) => {
    const name = person.name.toLowerCase()
    return name.startsWith(typed) || name.includes(` ${typed}`)
  })
}
