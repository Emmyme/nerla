import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { across, argumentAt, CLOSE, lineOf, OPEN, statementAt, statementBounds } from "./guardSource"

const TENANCY = join("services", "tenancy.ts")

const MARKED = /\/\/ tenancy: \S/

/** Lines of membership lookups by user alone, and of "the only organization" lookups */
function lookupProblems(text: string): number[] {
  const found: number[] = []
  for (const match of text.matchAll(/organizationMembers\.find(First|Many)\(/g)) {
    const where = argumentAt(text, match.index + match[0].length - 1).match(/where:([\s\S]*)/)?.[1] ?? ""
    if (!where.includes("organizationMembers.organizationId")) found.push(lineOf(text, match.index))
  }
  // A join is judged by its own condition and a select by what follows it, so selecting the org column never counts
  for (const match of text.matchAll(/\.from\(organizationMembers\)|Join\(\s*organizationMembers\b|organization_members/g)) {
    const [begin, end] = statementBounds(text, match.index)
    const scope = match[0].startsWith("Join")
      ? argumentAt(text, match.index + match[0].indexOf("("))
      : text.slice(match[0].startsWith(".from") ? match.index : begin, end)
    if (!/organizationMembers\.organizationId|organization_id|inOrg\(/.test(scope) && !MARKED.test(text.slice(begin, end))) {
      found.push(lineOf(text, match.index))
    }
  }
  for (const match of text.matchAll(/organizations\.find(First|Many)\(|\.from\(organizations\)/g)) {
    const statement = statementAt(text, match.index)
    if (!/where/.test(statement) && !MARKED.test(statement)) found.push(lineOf(text, match.index))
  }
  return [...new Set(found)].sort((a, b) => a - b)
}

/** The tables that carry organization_id on every row */
const ORG_TABLES = [
  "tasks",
  "messages",
  "fileAttachments",
  "taskComments",
  "taskActivity",
  "eventAttendees",
  "meetingParticipants",
  "calendarShareGrants",
  "messageReactions",
  "fileLinks",
  "fileGrants",
  "fileShareLinks",
  "projectPins",
  "notifications",
  "notificationPrefs",
  "timeEntries",
  "timeTimers",
  "timeDismissals",
  "timeMeetingProjects",
  "timeAutofillDays",
  "docContents",
  "docVersions",
  "docComments",
  "docCommentHides",
  "docMentions",
  "docCallShares",
  "docCallAttendees",
  "aiSettings",
  "aiPersonal",
  "aiPreferences",
  "aiTokens",
  "aiThreads",
  "aiMessages",
  "aiRequests",
  "aiHeld",
  "aiActivity",
  "aiUsage",
]
/** The main workspace tables, and the member rows that hang off them */
const MAIN_TABLES = ["projects", "projectMembers", "groupChats", "groupChatMembers", "calendarEvents", "fileFolders"]
const SCOPED = /organizationId|isMemberOf|membersOf|resolveOrg|request\.org\b|orgOf\(request\)/

// Any query or write on a named table. The table is checked against the list in code, so the pattern stays literal.
const QUERY_CALL = /\.query\.(\w+)\.find(?:First|Many)\(|\.(?:from|update|delete|insert)\((\w+)\)/g

const queriesOn = (text: string, tables: string[]) =>
  [...text.matchAll(QUERY_CALL)].filter((match) => tables.includes(match[1] ?? match[2]))

/** The value of the `where` property of the object literal `arg` holds, or "" when it has none */
function whereProperty(arg: string): string {
  let depth = 0
  for (let i = 0; i < arg.length; i++) {
    if (OPEN.includes(arg[i])) depth++
    else if (CLOSE.includes(arg[i])) depth--
    else if (depth === 1 && i > 0 && /^[\s{,]where\s*:/.test(arg.slice(i - 1, i + 12))) {
      const start = arg.indexOf(":", i) + 1
      for (let j = start, inner = 0; j < arg.length; j++) {
        if (OPEN.includes(arg[j])) inner++
        else if (CLOSE.includes(arg[j]) && --inner < 0) return arg.slice(start, j)
        else if (arg[j] === "," && inner === 0) return arg.slice(start, j)
      }
      return arg.slice(start)
    }
  }
  return ""
}

/** The arguments of the `.where(` and `.values(` calls of the query chain that continues at `start` */
function chainFilters(text: string, start: number): string {
  const end = statementBounds(text, start)[1]
  const found: string[] = []
  for (let i = start, depth = 0; i < end; i++) {
    if (depth === 0 && (text.startsWith(".where(", i) || text.startsWith(".values(", i))) {
      const open = text.indexOf("(", i)
      found.push(argumentAt(text, open))
    }
    if (OPEN.includes(text[i])) depth++
    else if (CLOSE.includes(text[i])) depth--
  }
  return found.join("\n")
}

/** What a query filters on: a relational query's `where`, else its chain's `.where(` calls, or an insert's values */
function filterOf(text: string, match: RegExpExecArray): string {
  const end = match.index + match[0].length
  return match[0].startsWith(".query.") ? whereProperty(argumentAt(text, end - 1)) : chainFilters(text, end)
}

/** Lines of queries on `tables` whose filter does not scope them to a workspace, unless a `// tenancy:` marker explains why */
const queryProblems =
  (tables: string[] = ORG_TABLES) =>
  (text: string): number[] =>
    queriesOn(text, tables)
      .filter((match) => !SCOPED.test(filterOf(text, match)) && !MARKED.test(statementAt(text, match.index)))
      .map((match) => lineOf(text, match.index))

describe("tenancy guard", () => {
  it("catches the lookups it guards against", () => {
    const bad = [
      "const m = await db.query.organizationMembers.findFirst({ where: eq(organizationMembers.userId, id) });",
      "const m = await db.query.organizationMembers.findFirst();",
      "const rows = await db.select().from(organizationMembers).where(eq(organizationMembers.userId, id));",
      "const rows = await db.select().from(users).leftJoin(organizationMembers, eq(organizationMembers.userId, users.id));",
      "const rows = await db.select({ org: organizationMembers.organizationId }).from(users).leftJoin(organizationMembers, eq(organizationMembers.userId, users.id));",
      "const rows = await db.select({ org: organizationMembers.organizationId }).from(organizationMembers).where(eq(organizationMembers.userId, id));",
      "await db.execute(sql`select * from organization_members where user_id = ${id}`);",
      "const org = await db.query.organizations.findFirst();",
      "const org = await db.query.organizations.findFirst({ columns: { id: true } });",
      "const [org] = await db.select().from(organizations).limit(1);",
    ]
    for (const sample of bad) expect(lookupProblems(sample), sample).not.toEqual([])
    const fine = [
      "const m = await db.query.organizationMembers.findFirst({ where: and(eq(organizationMembers.userId, id), eq(organizationMembers.organizationId, org)) });",
      "const rows = await db.select().from(organizationMembers).where(eq(organizationMembers.organizationId, org));",
      "const rows = await tx.select().from(projectMembers).innerJoin(organizationMembers, inOrg(project.organizationId));",
      "await db.execute(sql`select 1 from organization_members m where m.organization_id = ${org}`);",
      "// tenancy: every workspace on purpose\nconst rows = await db.select().from(organizationMembers);",
      "const org = await db.query.organizations.findFirst({ where: eq(organizations.id, id) });",
      "await db.insert(organizationMembers).values({ organizationId: org, userId: id });",
    ]
    for (const sample of fine) expect(lookupProblems(sample), sample).toEqual([])

    const unscoped = [
      "const t = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });",
      "const t = await db.query.tasks.findFirst({ where: eq(tasks.id, id), columns: { organizationId: true } });",
      "const t = await db.query.tasks.findFirst({ columns: { organizationId: true } });",
      "const [t] = await db.select({ org: tasks.organizationId }).from(tasks).where(eq(tasks.id, id));",
      "await db.update(tasks).set({ organizationId: org }).where(eq(tasks.id, id));",
      "await db.insert(tasks).values({ title });",
      "const rows = await db.select().from(tasks).innerJoin(projects, eq(projects.organizationId, org)).where(eq(tasks.id, id));",
      "const p = await db.query.projects.findFirst({ where: eq(projects.slug, slug), with: { organization: true } });",
    ]
    for (const sample of unscoped) expect(queryProblems([...ORG_TABLES, ...MAIN_TABLES])(sample), sample).not.toEqual([])
    const scoped = [
      "const t = await db.query.tasks.findFirst({ where: eq(tasks.organizationId, org) });",
      "const t = await db.query.tasks.findFirst({ columns: { id: true }, where: and(eq(tasks.id, id), eq(tasks.organizationId, org)) });",
      "const [t] = await db.select().from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId)).where(eq(tasks.organizationId, org));",
      "await db.update(tasks).set({ title }).where(and(eq(tasks.id, id), eq(tasks.organizationId, org)));",
      "await db.insert(tasks).values({ title, organizationId });",
      "const p = await db.query.projects.findFirst({ where: and(eq(projects.slug, slug), eq(projects.organizationId, orgOf(request).organizationId)) });",
      "// tenancy: the row id is already scoped\nawait tx.delete(messages).where(eq(messages.id, id));",
    ]
    for (const sample of scoped) expect(queryProblems([...ORG_TABLES, ...MAIN_TABLES])(sample), sample).toEqual([])
    expect(queryProblems()("const p = await db.query.projects.findFirst({ where: eq(projects.slug, slug) });")).toEqual([])
  })

  it("only services/tenancy.ts looks a caller's organization up", () => {
    expect(across(lookupProblems, TENANCY)).toEqual([])
  })

  // Counted on 2026-11-02 over every source file outside db/, judging only where clauses and insert values. Never raise them
  const UNMARKED_BASELINE = 32
  const MAIN_UNMARKED_BASELINE = 50

  it("adds no unscoped query on a table that carries organization_id", () => {
    expect(across(queryProblems(ORG_TABLES)).length).toBeLessThanOrEqual(UNMARKED_BASELINE)
  })

  it("adds no unscoped query on a main workspace table", () => {
    expect(across(queryProblems(MAIN_TABLES)).length).toBeLessThanOrEqual(MAIN_UNMARKED_BASELINE)
  })
})
