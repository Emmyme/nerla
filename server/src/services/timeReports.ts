import { and, asc, eq, gt, gte, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { db, projectMembers, projects, tasks, timeEntries, users } from "../db"
import { taskAccessLevel } from "../utils/taskAccess"
import { formatTaskIdentifier } from "../utils/taskKeys"
import { liveProject, liveTask } from "../utils/trash"
import { csvRow } from "../utils/timeRules"
import { projectReadAccess } from "./projectAccess"
import { addDays } from "./timeAutoFill"
import { TimeRefusal, type TimeViewer } from "./timeEntries"

export type ReportFilters = {
  from: string
  to: string
  people?: string[]
  projects?: string[]
  groupBy: "person" | "project" | "task"
}

type Person = { id: string; name: string; email: string }

type ReportEntry = {
  id: string
  date: string
  minutes: number
  note: string | null
  source: string
  person: Person
  project: { id: string; name: string; color: string | null } | null
  deletedProjectName: string | null
  task: { id: string; identifier: string | null; title: string } | null
  taskLabel: string | null
}

type LockDto = { projectId: string; name: string; lockedUntil: string | null }

type Report = {
  minutes: number
  groups: { id: string; label: string; minutes: number }[]
  entries: ReportEntry[]
  truncated: boolean
  lockable: LockDto[]
  options: { people: Person[]; projects: { id: string; name: string; color: string | null }[] }
}

export const MAX_REPORT_ENTRIES = 2000
const CSV_HEADER = ["Date", "Person", "Email", "Project", "Task ID", "Task", "Hours", "Minutes", "Note", "Source"]
const NOT_FOUND = "Not found"

/** Who the caller reports on: every project for a workspace admin, else only the projects they are an admin of now */
type Scope = { viewer: TimeViewer; adminProjectIds: string[]; memberProjectIds: Set<string> }

async function reportScope(viewer: TimeViewer): Promise<Scope> {
  const rows = await db
    .select({ projectId: projectMembers.projectId, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.userId, viewer.userId), eq(projects.organizationId, viewer.organizationId), liveProject))
  const adminProjectIds = rows.filter((row) => row.role === "admin").map((row) => row.projectId)
  if (!viewer.isOrgAdmin && adminProjectIds.length === 0) throw new TimeRefusal(404, NOT_FOUND)
  return { viewer, adminProjectIds, memberProjectIds: new Set(rows.map((row) => row.projectId)) }
}

/** Personal time is never in scope. A workspace admin also gets detached entries */
const scopeCondition = (scope: Scope) =>
  scope.viewer.isOrgAdmin
    ? or(isNotNull(timeEntries.projectId), isNotNull(timeEntries.detachedAt))
    : inArray(timeEntries.projectId, scope.adminProjectIds)

/** Entries in scope that match the filters. Auto entries that came to 0 minutes stay hidden */
const matching = (scope: Scope, filters: ReportFilters, from = filters.from, to = filters.to) =>
  and(
    gte(timeEntries.date, from),
    lte(timeEntries.date, to),
    gt(timeEntries.minutes, 0),
    scopeCondition(scope),
    filters.people?.length ? inArray(timeEntries.userId, filters.people) : undefined,
    filters.projects?.length ? inArray(timeEntries.projectId, filters.projects) : undefined,
  )

const personName = (person: { firstName: string | null; lastName: string | null; email: string }) =>
  [person.firstName, person.lastName].filter(Boolean).join(" ").trim() || person.email

const PERSON_ORDER = sql`lower(coalesce(nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), ''), ${users.email}))`
const MINUTES = sql<number>`coalesce(sum(${timeEntries.minutes}), 0)::int`

// trash: names the project of a task the time was logged on, which still counts while either is in Trash
const taskProjects = alias(projects, "task_projects")

function selectRows(scope: Scope, condition: SQL | undefined) {
  const { organizationId } = scope.viewer
  // trash: time on what is in Trash still counts, under its name
  return db
    .select({
      id: timeEntries.id,
      date: timeEntries.date,
      minutes: timeEntries.minutes,
      note: timeEntries.note,
      source: timeEntries.source,
      userId: timeEntries.userId,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      projectId: projects.id,
      projectName: projects.name,
      projectColor: projects.color,
      deletedProjectName: timeEntries.projectName,
      entryTaskId: timeEntries.taskId,
      taskTitle: tasks.title,
      taskNumber: tasks.number,
      taskProjectId: tasks.projectId,
      taskKey: taskProjects.key,
      taskLabel: timeEntries.taskLabel,
    })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .leftJoin(projects, and(eq(projects.id, timeEntries.projectId), eq(projects.organizationId, organizationId)))
    .leftJoin(tasks, and(eq(tasks.id, timeEntries.taskId), eq(tasks.organizationId, organizationId)))
    .leftJoin(taskProjects, and(eq(taskProjects.id, tasks.projectId), eq(taskProjects.organizationId, organizationId)))
    .where(and(eq(timeEntries.organizationId, organizationId), condition))
    .orderBy(
      asc(timeEntries.date),
      PERSON_ORDER,
      sql`lower(coalesce(${projects.name}, ${timeEntries.projectName}, ''))`,
      asc(timeEntries.createdAt),
      asc(timeEntries.id),
    )
    .$dynamic()
}

type ReportRow = Awaited<ReturnType<typeof selectRows>>[number]

/** A task shows only while it sits in a project the caller can open, so a task made personal since stays hidden */
const taskVisible = (scope: Scope, taskProjectId: string | null) =>
  !!taskProjectId && (scope.viewer.isOrgAdmin || scope.memberProjectIds.has(taskProjectId))

function toReportEntry(scope: Scope, row: ReportRow): ReportEntry {
  const task =
    row.entryTaskId && row.taskTitle !== null && taskVisible(scope, row.taskProjectId)
      ? { id: row.entryTaskId, identifier: formatTaskIdentifier(row.taskKey, row.taskNumber), title: row.taskTitle }
      : null
  return {
    id: row.id,
    date: row.date,
    minutes: row.minutes,
    note: row.note,
    source: row.source,
    person: { id: row.userId, name: personName(row), email: row.email },
    project: row.projectId && row.projectName !== null ? { id: row.projectId, name: row.projectName, color: row.projectColor } : null,
    deletedProjectName: row.projectId ? null : row.deletedProjectName,
    task,
    taskLabel: row.entryTaskId ? null : row.taskLabel,
  }
}

type Group = Report["groups"][number]

function addTo(groups: Map<string, Group>, id: string, label: string, minutes: number) {
  const group = groups.get(id)
  if (group) group.minutes += minutes
  else groups.set(id, { id, label, minutes })
}

const sortedGroups = (groups: Map<string, Group>) =>
  [...groups.values()].sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label))

async function projectTotals(scope: Scope, filters: ReportFilters) {
  const { organizationId } = scope.viewer
  // trash: time on what is in Trash still counts, under its name
  return db
    .select({
      projectId: projects.id,
      name: projects.name,
      lockedUntil: projects.timeLockedUntil,
      deletedName: timeEntries.projectName,
      minutes: MINUTES,
    })
    .from(timeEntries)
    .leftJoin(projects, and(eq(projects.id, timeEntries.projectId), eq(projects.organizationId, organizationId)))
    .where(and(eq(timeEntries.organizationId, organizationId), matching(scope, filters)))
    .groupBy(projects.id, projects.name, projects.timeLockedUntil, timeEntries.projectName)
}

async function personGroups(scope: Scope, filters: ReportFilters): Promise<Map<string, Group>> {
  const { organizationId } = scope.viewer
  const rows = await db
    .select({ userId: timeEntries.userId, firstName: users.firstName, lastName: users.lastName, email: users.email, minutes: MINUTES })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .where(and(eq(timeEntries.organizationId, organizationId), matching(scope, filters)))
    .groupBy(timeEntries.userId, users.firstName, users.lastName, users.email)
  const groups = new Map<string, Group>()
  for (const row of rows) addTo(groups, row.userId, personName(row), row.minutes)
  return groups
}

async function taskGroups(scope: Scope, filters: ReportFilters): Promise<Map<string, Group>> {
  const { organizationId } = scope.viewer
  // trash: time on what is in Trash still counts, under its name
  const rows = await db
    .select({
      taskId: timeEntries.taskId,
      taskLabel: timeEntries.taskLabel,
      title: tasks.title,
      number: tasks.number,
      taskProjectId: tasks.projectId,
      key: taskProjects.key,
      minutes: MINUTES,
    })
    .from(timeEntries)
    .leftJoin(tasks, and(eq(tasks.id, timeEntries.taskId), eq(tasks.organizationId, organizationId)))
    .leftJoin(taskProjects, and(eq(taskProjects.id, tasks.projectId), eq(taskProjects.organizationId, organizationId)))
    .where(and(eq(timeEntries.organizationId, organizationId), matching(scope, filters)))
    .groupBy(timeEntries.taskId, timeEntries.taskLabel, tasks.title, tasks.number, tasks.projectId, taskProjects.key)
  const groups = new Map<string, Group>()
  for (const row of rows) {
    if (row.taskId && row.title !== null && taskVisible(scope, row.taskProjectId)) {
      const identifier = formatTaskIdentifier(row.key, row.number)
      addTo(groups, row.taskId, identifier ? `${identifier} ${row.title}` : row.title, row.minutes)
    } else if (!row.taskId && row.taskLabel) {
      addTo(groups, `deleted:${row.taskLabel}`, `Deleted task: ${row.taskLabel}`, row.minutes)
    } else {
      addTo(groups, "none", "No task", row.minutes)
    }
  }
  return groups
}

/** The users and projects the caller may filter by: the scope's projects, their members and whoever logged time in it */
async function reportOptions(scope: Scope): Promise<Report["options"]> {
  const { organizationId, isOrgAdmin } = scope.viewer
  const projectRows = await db
    .select({ id: projects.id, name: projects.name, color: projects.color })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isOrgAdmin ? undefined : and(liveProject, inArray(projects.id, scope.adminProjectIds)),
      ),
    )
    .orderBy(sql`lower(${projects.name})`)
  const members = await db
    .selectDistinct({ userId: projectMembers.userId })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isOrgAdmin ? undefined : and(liveProject, inArray(projectMembers.projectId, scope.adminProjectIds)),
      ),
    )
  const authors = await db
    .selectDistinct({ userId: timeEntries.userId })
    .from(timeEntries)
    .where(and(eq(timeEntries.organizationId, organizationId), scopeCondition(scope)))
  const ids = [...new Set([...members, ...authors].map((row) => row.userId))]
  const people = ids.length
    ? await db
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(users)
        .where(inArray(users.id, ids))
    : []
  return {
    people: people
      .map((person) => ({ id: person.id, name: personName(person), email: person.email }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    projects: projectRows,
  }
}

export async function timeReport(viewer: TimeViewer, filters: ReportFilters): Promise<Report> {
  const scope = await reportScope(viewer)
  const totals = await projectTotals(scope, filters)
  let groups: Map<string, Group>
  if (filters.groupBy === "person") groups = await personGroups(scope, filters)
  else if (filters.groupBy === "task") groups = await taskGroups(scope, filters)
  else {
    groups = new Map()
    for (const row of totals) {
      if (row.projectId && row.name !== null) addTo(groups, row.projectId, row.name, row.minutes)
      else addTo(groups, `deleted:${row.deletedName ?? ""}`, `Deleted project: ${row.deletedName ?? ""}`, row.minutes)
    }
  }
  const rows = await selectRows(scope, matching(scope, filters)).limit(MAX_REPORT_ENTRIES + 1)
  const lockable = totals
    .filter((row): row is typeof row & { projectId: string; name: string } => !!row.projectId && row.name !== null)
    .map((row) => ({ projectId: row.projectId, name: row.name, lockedUntil: row.lockedUntil }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    minutes: totals.reduce((sum, row) => sum + row.minutes, 0),
    groups: sortedGroups(groups),
    entries: rows.slice(0, MAX_REPORT_ENTRIES).map((row) => toReportEntry(scope, row)),
    truncated: rows.length > MAX_REPORT_ENTRIES,
    lockable,
    options: await reportOptions(scope),
  }
}

function csvLine(entry: ReportEntry): string {
  return csvRow([
    entry.date,
    entry.person.name,
    entry.person.email,
    entry.project?.name ?? entry.deletedProjectName ?? "",
    entry.task?.identifier ?? "",
    entry.task?.title ?? entry.taskLabel ?? "",
    String(Number((entry.minutes / 60).toFixed(4))),
    String(entry.minutes),
    entry.note ?? "",
    entry.source,
  ])
}

const CSV_DAYS_PER_READ = 7

/** Every matching row, a week at a time, ordered by date, user and project. The scope is checked before anything is sent */
export async function timeReportCsv(viewer: TimeViewer, filters: ReportFilters): Promise<AsyncGenerator<string>> {
  const scope = await reportScope(viewer)
  async function* lines() {
    yield `\uFEFF${csvRow(CSV_HEADER)}\r\n`
    for (let from = filters.from; from <= filters.to; from = addDays(from, CSV_DAYS_PER_READ)) {
      const last = addDays(from, CSV_DAYS_PER_READ - 1)
      const rows = await selectRows(scope, matching(scope, filters, from, last < filters.to ? last : filters.to))
      if (rows.length) yield rows.map((row) => `${csvLine(toReportEntry(scope, row))}\r\n`).join("")
    }
  }
  return lines()
}

async function lockList(scope: Scope): Promise<LockDto[]> {
  const { organizationId, isOrgAdmin } = scope.viewer
  return db
    .select({ projectId: projects.id, name: projects.name, lockedUntil: projects.timeLockedUntil })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isOrgAdmin ? undefined : and(liveProject, inArray(projects.id, scope.adminProjectIds)),
      ),
    )
    .orderBy(sql`lower(${projects.name})`)
}

export async function timeLocks(viewer: TimeViewer): Promise<LockDto[]> {
  return lockList(await reportScope(viewer))
}

/** Sets, moves or clears the lock date. Moving it earlier, or to null, unlocks and needs the same rights */
export async function setTimeLocks(viewer: TimeViewer, projectIds: string[] | "all", until: string | null): Promise<LockDto[]> {
  const scope = await reportScope(viewer)
  const { organizationId, isOrgAdmin } = viewer
  if (projectIds === "all" && !isOrgAdmin) throw new TimeRefusal(403, "Only workspace admins can lock every project")
  const wanted = projectIds === "all" ? null : [...new Set(projectIds)]
  if (wanted && !isOrgAdmin) {
    const admins = new Set(scope.adminProjectIds)
    if (wanted.some((id) => !scope.memberProjectIds.has(id))) throw new TimeRefusal(404, "Project not found")
    if (wanted.some((id) => !admins.has(id))) throw new TimeRefusal(403, "Only project admins can lock time")
  }
  await db.transaction(async (tx) => {
    // In id order, so two lock changes never wait on each other in a circle
    const locked = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), liveProject, wanted ? inArray(projects.id, wanted) : undefined))
      .orderBy(asc(projects.id))
      .for("update")
    if (wanted && locked.length !== wanted.length) throw new TimeRefusal(404, "Project not found")
    if (!locked.length) return
    await tx
      .update(projects)
      .set({ timeLockedUntil: until })
      .where(
        and(
          eq(projects.organizationId, organizationId),
          inArray(
            projects.id,
            locked.map((row) => row.id),
          ),
        ),
      )
  })
  return lockList(scope)
}

async function minutesOn(organizationId: string, condition: SQL | undefined, lockedUntil: string | null) {
  const [row] = await db
    .select({
      minutes: MINUTES,
      lockedMinutes: lockedUntil
        ? sql<number>`coalesce(sum(${timeEntries.minutes}) filter (where ${timeEntries.date} <= ${lockedUntil}), 0)::int`
        : sql<number>`0`,
    })
    .from(timeEntries)
    .where(and(eq(timeEntries.organizationId, organizationId), condition))
  return { minutes: Number(row?.minutes ?? 0), lockedMinutes: Number(row?.lockedMinutes ?? 0) }
}

const HIDDEN_IMPACT = { minutes: null, lockedMinutes: null }

/**
 * What deleting a project or task would touch: everything logged on it, and the locked part that is kept. Only its
 * project's admins and workspace admins get the numbers
 */
export async function placeImpact(
  viewer: TimeViewer,
  place: { projectId?: string; taskId?: string },
): Promise<{ minutes: number | null; lockedMinutes: number | null }> {
  const { organizationId, userId, isOrgAdmin } = viewer
  if (place.projectId) {
    const access = await projectReadAccess(userId, organizationId, place.projectId)
    if (!access) throw new TimeRefusal(404, "Project not found")
    if (!isOrgAdmin && access.role !== "admin") return HIDDEN_IMPACT
    return minutesOn(organizationId, eq(timeEntries.projectId, access.project.id), access.project.timeLockedUntil)
  }
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, place.taskId!), eq(tasks.organizationId, organizationId), liveTask),
    columns: { id: true, projectId: true, assignedTo: true, organizationId: true, deletedAt: true },
    with: {
      project: {
        columns: { organizationId: true, timeLockedUntil: true, deletedAt: true },
        with: { members: { where: eq(projectMembers.userId, userId), columns: { userId: true, role: true } } },
      },
    },
  })
  if (!task || !taskAccessLevel(task, userId, organizationId, isOrgAdmin)) throw new TimeRefusal(404, "Task not found")
  const isAdmin = isOrgAdmin || !!task.project?.members?.some((member) => member.role === "admin")
  if (!task.projectId || !isAdmin) return HIDDEN_IMPACT
  return minutesOn(
    organizationId,
    and(eq(timeEntries.taskId, task.id), eq(timeEntries.projectId, task.projectId)),
    task.project?.timeLockedUntil ?? null,
  )
}
