import { describe, expect, it } from "vitest"
import { across, CLOSE, lineOf, OPEN, statementBounds } from "./guardSource"

// Drizzle reads, joins and aliases, an interpolated table, a sql.raw string and a hand-written from or join
const READ =
  /\.from\((tasks|calendarEvents|projects)\)|\.query\.(tasks|calendarEvents|projects)\.|[jJ]oin\(\s*(tasks|calendarEvents|projects)\b|\balias\(\s*(tasks|calendarEvents|projects)\b|\$\{(tasks|calendarEvents|projects)\}|sql\.raw\(\s*["'`][^"'`]*?\b(?:from|join)\s+"?(tasks|calendar_events|projects)\b|\b(?:from|join)\s+"?(tasks|calendar_events|projects)\b/g
const LIVE = {
  tasks: /\bliveTask\b|LIVE_TASK_SQL\(|\btasks\.deletedAt\b/,
  calendarEvents: /\bliveEvent\b|LIVE_EVENT_SQL\(|\bcalendarEvents\.deletedAt\b/,
  projects: /\bliveProject\b|LIVE_PROJECT_SQL\(|\bprojects\.deletedAt\b/,
}
const MARKED = /\/\/ trash: \S/

const skipTo = (text: string, end: string, from: number) => {
  const at = text.indexOf(end, from)
  return at === -1 ? text.length : at
}

type Layout = { templates: [number, number][]; quiet: [number, number][]; masked: string }

/**
 * Where the outermost template literals are, and the comments and strings in code. `masked` blanks all of them, so
 * brackets and commas in SQL, strings and comments never move a statement's bounds
 */
function layout(text: string): Layout {
  const templates: [number, number][] = []
  const quiet: [number, number][] = []
  const open: number[] = []
  const braces = [0]
  let inTemplate = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inTemplate) {
      if (c === "\\") i++
      else if (c === "`") {
        const from = open.pop()!
        if (open.length === 0) templates.push([from, i])
        inTemplate = false
      } else if (c === "$" && text[i + 1] === "{") {
        braces.push(0)
        inTemplate = false
        i++
      }
    } else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      const end = text[i + 1] === "/" ? skipTo(text, "\n", i) : skipTo(text, "*/", i) + 1
      quiet.push([i, end])
      i = end
    } else if (c === "'" || c === '"') {
      const from = i
      for (i++; i < text.length && text[i] !== c && text[i] !== "\n"; i++) if (text[i] === "\\") i++
      quiet.push([from, i])
    } else if (c === "`") {
      open.push(i)
      inTemplate = true
    } else if (c === "{") braces[braces.length - 1]++
    else if (c === "}") {
      if (braces[braces.length - 1] === 0 && braces.length > 1) {
        braces.pop()
        inTemplate = true
      } else braces[braces.length - 1]--
    }
  }
  const chars = [...text]
  for (const [from, to] of [...templates.map(([a, b]): [number, number] => [a + 1, b - 1]), ...quiet]) {
    for (let i = from; i <= to && i < chars.length; i++) if (chars[i] !== "\n") chars[i] = " "
  }
  return { templates, quiet, masked: chars.join("") }
}

const within = (ranges: [number, number][], index: number) => ranges.find(([from, to]) => from <= index && index <= to)

/** The statement around `index`, cut at commas outside brackets, so a sibling argument's filter never counts */
function pieceBounds(masked: string, index: number): [number, number] {
  const [begin, end] = statementBounds(masked, index)
  let from = index
  for (let depth = 0; from > begin; from--) {
    const c = masked[from - 1]
    if (CLOSE.includes(c)) depth++
    else if (OPEN.includes(c)) depth--
    else if (c === "," && depth === 0) break
  }
  let to = index
  for (let depth = 0; to < end; to++) {
    const c = masked[to]
    if (OPEN.includes(c)) depth++
    else if (CLOSE.includes(c)) depth--
    else if (c === "," && depth === 0) break
  }
  return [from, to]
}

/** A hand-written query is judged with the calls that hold its template */
function templateBounds(masked: string, start: number): [number, number] {
  let [begin, end] = pieceBounds(masked, start)
  while (begin > 0 && "([".includes(masked[begin - 1])) [begin, end] = pieceBounds(masked, begin - 1)
  return [begin, end]
}

const TABLE_KEY: Record<string, keyof typeof LIVE> = {
  tasks: "tasks",
  calendarEvents: "calendarEvents",
  calendar_events: "calendarEvents",
  projects: "projects",
}

/** Lines of reads on tasks, events or projects that keep trashed rows, unless a `// trash:` note explains why */
function trashProblems(text: string): number[] {
  const found: number[] = []
  const { templates, quiet, masked } = layout(text)
  for (const match of text.matchAll(READ)) {
    const table = TABLE_KEY[match.slice(1).find((group) => group && group in TABLE_KEY)!]
    const template = within(templates, match.index)
    const prose = match[0].startsWith("from") || match[0].startsWith("join")
    if ((prose && !template) || within(quiet, match.index)) continue
    const scope = text.slice(...(template ? templateBounds(masked, template[0]) : pieceBounds(masked, match.index)))
    if (!LIVE[table].test(scope) && !MARKED.test(scope)) found.push(lineOf(text, match.index))
  }
  return [...new Set(found)]
}

describe("trash guard", () => {
  it("keeps trashed tasks, events and projects out of every query", () => {
    const bad = [
      "const t = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });",
      "const rows = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id));",
      "const rows = await db.select().from(chats).leftJoin(projects, eq(projects.id, chats.projectId));",
      "const rows = await db.select().from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId)).where(liveTask);",
      "await db.execute(sql`select * from tasks t where t.id = ${id}`);",
      "const [a, b] = await Promise.all([db.query.tasks.findMany({ where: eq(tasks.id, id) }), db.query.projects.findMany({ where: liveProject })]);",
      'const master = alias(calendarEvents, "master");',
      "await db.execute(sql`select * from ${projects} p where p.id = ${id}`);",
      'const rows = await db.execute(sql.raw("select id from calendar_events where cancelled"));',
    ]
    for (const sample of bad) expect(trashProblems(sample), sample).not.toEqual([])
    const fine = [
      "const t = await db.query.tasks.findFirst({ where: and(eq(tasks.id, id), liveTask) });",
      "const rows = await db.select().from(tasks).innerJoin(projects, and(eq(projects.id, tasks.projectId), liveProject)).where(liveTask);",
      'await db.execute(sql`select * from tasks t where t.id = ${id} and ${LIVE_TASK_SQL("t")}`);',
      "// trash: restore reads the trashed row\nconst t = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });",
      "// Leaves people out from projects they left",
    ]
    for (const sample of fine) expect(trashProblems(sample), sample).toEqual([])

    expect(across(trashProblems)).toEqual([])
  })
})
