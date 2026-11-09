import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm"
import {
  calendarEvents,
  db,
  eventAttendees,
  organizations,
  projectMembers,
  projects,
  tasks,
  timeEntries,
  timeMeetingProjects,
  timeTimers,
  users,
  type Executor,
  type Tx,
} from "../db"
import type { Via } from "../utils/aiTypes"
import { storedMs, readInstant } from "../utils/eventTime"
import { logger } from "../utils/logger"
import { taskAccessLevel } from "../utils/taskAccess"
import { formatTaskIdentifier } from "../utils/taskKeys"
import { liveEvent, liveProject, liveTask } from "../utils/trash"
import { canEditEntry, canSeeEntry, capTimer, isLocked, localDate, taskNamed } from "../utils/timeRules"
import { ADMIN_VIEWER, projectReadAccess } from "./projectAccess"
import { lockedUntilOf, refreshAutoFill } from "./timeAutoFill"
import { sendToUser } from "./websocket"
import { UUID } from "../utils/uuid"
import { errorText } from "../utils/errorText"

type Row = typeof timeEntries.$inferSelect
type TimerRow = typeof timeTimers.$inferSelect
type Place = { projectId: string | null; taskId: string | null }

export type TimeViewer = { userId: string; organizationId: string; isOrgAdmin: boolean }

export type ProjectRef = { id: string; name: string; color: string | null }
export type TaskRef = { id: string; identifier: string | null; title: string }

export type EntryDto = {
  id: string
  date: string
  minutes: number
  note: string | null
  source: string
  project: ProjectRef | null
  deletedProjectName: string | null
  task: TaskRef | null
  taskLabel: string | null
  locked: boolean
  needsCheck: boolean
  auto: boolean
  edited: boolean
  done_via: Via | null
}

type TimerDto = { startedAt: string; project: ProjectRef | null; task: TaskRef | null; note: string | null }

/** A refusal the routes send as is */
export class TimeRefusal extends Error {
  constructor(
    readonly code: 400 | 403 | 404,
    message: string,
  ) {
    super(message)
  }
}

const ENTRY_GONE = "Entry not found"
const LOCKED = "This day is locked"
const JOIN_FIRST = "Join this project to log time"

function push(organizationId: string, userId: string, type: string, payload: Record<string, unknown>) {
  try {
    sendToUser(organizationId, userId, { type, ...payload })
  } catch (error) {
    logger.warn("Sending a time update failed", { error: errorText(error) })
  }
}

export const pushChanged = (organizationId: string, userId: string, dates: string[]) =>
  push(organizationId, userId, "time:changed", { dates: [...new Set(dates)] })

/** One writer at a time per user, so a timer and its entries never race */
export const lockPerson = (tx: Tx, organizationId: string, userId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`time:${organizationId}:${userId}`}, 0))`)

/** Runs after any change to a user's entries on those dates, inside the same transaction and user lock */
async function afterEntryChange(tx: Tx, organizationId: string, userId: string, dates: string[]): Promise<void> {
  for (const date of new Set(dates)) await refreshAutoFill(tx, organizationId, userId, date)
}

export async function timeTrackingOn(organizationId: string): Promise<boolean> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
    columns: { timeTracking: true },
  })
  return !!org?.timeTracking
}

/** Refuses while the workspace has time tracking off, holding the switch so turning it off waits for this write */
async function refuseWhenOff(tx: Tx, organizationId: string): Promise<void> {
  const [org] = await tx
    .select({ timeTracking: organizations.timeTracking })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("share")
  if (!org?.timeTracking) throw new TimeRefusal(404, "Not found")
}

const lockOf = async (tx: Tx, organizationId: string, projectId: string | null) =>
  projectId ? lockedUntilOf(tx, organizationId, projectId) : null

async function projectIdsWhere(executor: Executor, viewer: TimeViewer, condition?: SQL): Promise<Set<string>> {
  const rows = await executor
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.userId, viewer.userId), eq(projects.organizationId, viewer.organizationId), liveProject, condition))
  return new Set(rows.map((row) => row.projectId))
}

const adminProjectIds = (executor: Executor, viewer: TimeViewer) => projectIdsWhere(executor, viewer, eq(projectMembers.role, "admin"))

/** Where new time goes. A task's current project wins, and the caller must be in that project or own the personal task */
async function placeFor(
  executor: Executor,
  viewer: TimeViewer,
  wanted: { projectId?: string | null; taskId?: string | null },
): Promise<Place> {
  if (wanted.taskId) {
    const task = await executor.query.tasks.findFirst({
      where: and(eq(tasks.id, wanted.taskId), eq(tasks.organizationId, viewer.organizationId), liveTask),
      columns: { id: true, projectId: true, assignedTo: true, organizationId: true, deletedAt: true },
      with: {
        project: {
          columns: { organizationId: true, deletedAt: true },
          with: { members: { where: eq(projectMembers.userId, viewer.userId), columns: { userId: true } } },
        },
      },
    })
    const level = task ? taskAccessLevel(task, viewer.userId, viewer.organizationId, viewer.isOrgAdmin) : null
    if (!task || !level) throw new TimeRefusal(404, "Task not found")
    if (level !== "member") throw new TimeRefusal(403, JOIN_FIRST)
    return { projectId: task.projectId, taskId: task.id }
  }
  if (!wanted.projectId) throw new TimeRefusal(400, "Pick a project or a task")
  const access = await projectReadAccess(viewer.userId, viewer.organizationId, wanted.projectId, executor)
  if (!access) throw new TimeRefusal(404, "Project not found")
  if (access.role === ADMIN_VIEWER) throw new TimeRefusal(403, JOIN_FIRST)
  return { projectId: access.project.id, taskId: null }
}

const ruleShape = (row: Row) => ({
  userId: row.userId,
  projectId: row.projectId,
  taskId: row.taskId,
  detached: row.detachedAt !== null,
  date: row.date,
})

/** The caller's own entry for a change. Another user's is 404 unless the caller may see it, then 403 */
async function ownEntry(tx: Tx, viewer: TimeViewer, id: string): Promise<Row> {
  const [row] = await tx
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.id, id), eq(timeEntries.organizationId, viewer.organizationId)))
    .for("update")
  if (!row) throw new TimeRefusal(404, ENTRY_GONE)
  if (row.userId === viewer.userId) return row
  const admins = row.projectId && !viewer.isOrgAdmin ? await adminProjectIds(tx, viewer) : new Set<string>()
  if (!canSeeEntry(ruleShape(row), { ...viewer, adminProjectIds: admins })) throw new TimeRefusal(404, ENTRY_GONE)
  throw new TimeRefusal(403, "Only the person who logged this time can change it")
}

function refuseEdit(verdict: ReturnType<typeof canEditEntry>) {
  if (verdict === "hidden") throw new TimeRefusal(404, ENTRY_GONE)
  if (verdict === "locked") throw new TimeRefusal(403, LOCKED)
  if (verdict === "read-only") throw new TimeRefusal(403, "You are no longer in this project, so this entry is read-only")
}

/** Names of the places on one user's own time, joined directly so they still see entries on projects they left */
export async function refsOf(executor: Executor, organizationId: string, userId: string, places: Place[]) {
  const projectIds = [...new Set(places.map((place) => place.projectId).filter((id): id is string => !!id))]
  const taskIds = [...new Set(places.map((place) => place.taskId).filter((id): id is string => !!id))]
  // trash: time on what is in Trash still shows with its name
  const projectRows = projectIds.length
    ? await executor
        .select({ id: projects.id, name: projects.name, color: projects.color, lockedUntil: projects.timeLockedUntil })
        .from(projects)
        .where(and(inArray(projects.id, projectIds), eq(projects.organizationId, organizationId)))
    : []
  // trash: time on what is in Trash still shows with its name
  const taskRows = taskIds.length
    ? await executor
        .select({
          id: tasks.id,
          title: tasks.title,
          number: tasks.number,
          projectId: tasks.projectId,
          assignedTo: tasks.assignedTo,
          key: projects.key,
          member: projectMembers.userId,
        })
        .from(tasks)
        .leftJoin(projects, and(eq(projects.id, tasks.projectId), eq(projects.organizationId, organizationId)))
        .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
        .where(and(inArray(tasks.id, taskIds), eq(tasks.organizationId, organizationId)))
    : []
  return {
    userId,
    projects: new Map(projectRows.map((row) => [row.id, row])),
    tasks: new Map(taskRows.map((row) => [row.id, row])),
  }
}

type Refs = Awaited<ReturnType<typeof refsOf>>

const HIDDEN_TASK = "A task you can no longer open"

export const projectRef = (refs: Refs, id: string | null): ProjectRef | null => {
  const project = id ? refs.projects.get(id) : undefined
  return project ? { id: project.id, name: project.name, color: project.color } : null
}

/** Whether the place's task may still be shown by its current name and key */
export function taskShown(refs: Refs, place: Place): boolean {
  const task = place.taskId ? refs.tasks.get(place.taskId) : undefined
  return !!task && taskNamed({ ...task, isMember: task.member !== null }, place.projectId, refs.userId)
}

/** The place's task. One the user can no longer open shows its saved label, or says so, and has no key */
export function taskRef(refs: Refs, place: Place & { taskLabel?: string | null }): TaskRef | null {
  const task = place.taskId ? refs.tasks.get(place.taskId) : undefined
  if (!task) return null
  if (taskShown(refs, place)) return { id: task.id, identifier: formatTaskIdentifier(task.key, task.number), title: task.title }
  return { id: task.id, identifier: null, title: place.taskLabel || HIDDEN_TASK }
}

export function toEntryDto(row: Row, refs: Refs): EntryDto {
  const project = projectRef(refs, row.projectId)
  const task = taskRef(refs, row)
  const lockedUntil = row.projectId ? (refs.projects.get(row.projectId)?.lockedUntil ?? null) : null
  return {
    id: row.id,
    date: row.date,
    minutes: row.minutes,
    note: row.note,
    source: row.source,
    project,
    deletedProjectName: project ? null : row.projectName,
    task,
    taskLabel: task ? null : row.taskLabel,
    locked: row.detachedAt !== null || isLocked(row, lockedUntil),
    needsCheck: row.needsCheck,
    auto: row.source === "auto",
    edited: row.autoEdited,
    done_via: row.doneVia ?? null,
  }
}

/** One user's own entries */
async function entryDtos(executor: Executor, organizationId: string, userId: string, rows: Row[]): Promise<EntryDto[]> {
  const refs = await refsOf(executor, organizationId, userId, rows)
  return rows.map((row) => toEntryDto(row, refs))
}

async function entryDto(executor: Executor, organizationId: string, row: Row): Promise<EntryDto> {
  const [dto] = await entryDtos(executor, organizationId, row.userId, [row])
  return dto
}

async function timerDto(executor: Executor, organizationId: string, timer: TimerRow): Promise<TimerDto> {
  const refs = await refsOf(executor, organizationId, timer.userId, [timer])
  return {
    startedAt: readInstant(timer.startedAt) ?? timer.startedAt,
    project: projectRef(refs, timer.projectId),
    task: taskRef(refs, timer),
    note: timer.note,
  }
}

type EntryInput = {
  date: string
  minutes: number
  projectId?: string
  taskId?: string
  note?: string | null
  source: "manual" | "suggestion"
  suggestionKey?: string
}

export async function createEntry(viewer: TimeViewer, input: EntryInput, via: Via | null = null): Promise<EntryDto> {
  const { organizationId, userId } = viewer
  const row = await db.transaction(async (tx) => {
    await lockPerson(tx, organizationId, userId)
    await refuseWhenOff(tx, organizationId)
    const place = await placeFor(tx, viewer, input)
    if (isLocked({ projectId: place.projectId, date: input.date }, await lockOf(tx, organizationId, place.projectId))) {
      throw new TimeRefusal(403, LOCKED)
    }
    const now = new Date().toISOString()
    const [created] = await tx
      .insert(timeEntries)
      .values({
        organizationId,
        userId,
        ...place,
        date: input.date,
        minutes: input.minutes,
        note: input.note || null,
        source: input.source,
        suggestionKey: input.source === "suggestion" ? (input.suggestionKey ?? null) : null,
        doneVia: via,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    if (input.source === "suggestion" && input.suggestionKey && place.projectId) {
      await rememberMeetingProject(tx, viewer, input.suggestionKey, place.projectId)
    }
    await afterEntryChange(tx, organizationId, userId, [created.date])
    return created
  })
  pushChanged(organizationId, userId, [row.date])
  return entryDto(db, organizationId, row)
}

/** A meeting accepted with a project brings that project to later meetings with the same title */
async function rememberMeetingProject(tx: Tx, viewer: TimeViewer, key: string, projectId: string) {
  const { organizationId, userId } = viewer
  const [kind, eventId] = key.split(":")
  if (kind !== "meeting" || !UUID.test(eventId ?? "")) return
  const [event] = await tx
    .select({ title: calendarEvents.title, createdBy: calendarEvents.createdBy })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.organizationId, organizationId), liveEvent))
  if (!event) return
  if (event.createdBy !== userId) {
    const [guest] = await tx
      .select({ eventId: eventAttendees.eventId })
      .from(eventAttendees)
      .where(and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.userId, userId), eq(eventAttendees.organizationId, organizationId)))
    if (!guest) return
  }
  const titleKey = meetingTitleKey(event.title)
  if (!titleKey) return
  const at = new Date().toISOString()
  const [known] = await tx
    .select({ id: timeMeetingProjects.id })
    .from(timeMeetingProjects)
    .where(
      and(
        eq(timeMeetingProjects.organizationId, organizationId),
        eq(timeMeetingProjects.userId, userId),
        eq(timeMeetingProjects.titleKey, titleKey),
      ),
    )
    .limit(1)
  if (known) {
    await tx
      .update(timeMeetingProjects)
      .set({ projectId, updatedAt: at })
      .where(and(eq(timeMeetingProjects.id, known.id), eq(timeMeetingProjects.organizationId, organizationId)))
  } else {
    await tx.insert(timeMeetingProjects).values({ organizationId, userId, titleKey, projectId, updatedAt: at })
  }
}

export const meetingTitleKey = (title: string) => title.trim().toLowerCase().slice(0, 255)

type EntryChanges = {
  date?: string
  minutes?: number
  note?: string | null
  projectId?: string
  taskId?: string | null
}

export async function updateEntry(viewer: TimeViewer, id: string, changes: EntryChanges): Promise<EntryDto> {
  const { organizationId, userId } = viewer
  const { row, dates } = await db.transaction(async (tx) => {
    await lockPerson(tx, organizationId, userId)
    const entry = await ownEntry(tx, viewer, id)
    const owner = { userId, memberProjectIds: await projectIdsWhere(tx, viewer) }
    const lockedUntil = await lockOf(tx, organizationId, entry.projectId)
    refuseEdit(canEditEntry(ruleShape(entry), owner, lockedUntil))
    const moves = changes.projectId !== undefined || changes.taskId !== undefined
    // Naming only a project leaves the old task behind
    const place: Place = moves
      ? await placeFor(tx, viewer, {
          projectId: changes.projectId ?? entry.projectId,
          taskId: changes.taskId !== undefined ? changes.taskId : changes.projectId !== undefined ? null : entry.taskId,
        })
      : { projectId: entry.projectId, taskId: entry.taskId }
    const date = changes.date ?? entry.date
    refuseEdit(canEditEntry(ruleShape(entry), owner, lockedUntil, { date, lockedUntil: await lockOf(tx, organizationId, place.projectId) }))
    const [updated] = await tx
      .update(timeEntries)
      .set({
        ...place,
        date,
        ...(changes.minutes !== undefined ? { minutes: changes.minutes } : {}),
        ...(changes.note !== undefined ? { note: changes.note || null } : {}),
        needsCheck: false,
        autoEdited: entry.autoEdited || entry.source === "auto",
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(timeEntries.id, entry.id), eq(timeEntries.organizationId, organizationId)))
      .returning()
    const touched = [...new Set([entry.date, date])]
    await afterEntryChange(tx, organizationId, userId, touched)
    return { row: updated, dates: touched }
  })
  pushChanged(organizationId, userId, dates)
  return entryDto(db, organizationId, row)
}

export async function deleteEntry(viewer: TimeViewer, id: string): Promise<void> {
  const { organizationId, userId } = viewer
  const date = await db.transaction(async (tx) => {
    await lockPerson(tx, organizationId, userId)
    const entry = await ownEntry(tx, viewer, id)
    const members = await projectIdsWhere(tx, viewer)
    refuseEdit(canEditEntry(ruleShape(entry), { userId, memberProjectIds: members }, await lockOf(tx, organizationId, entry.projectId)))
    await tx.delete(timeEntries).where(and(eq(timeEntries.id, entry.id), eq(timeEntries.organizationId, organizationId)))
    await afterEntryChange(tx, organizationId, userId, [entry.date])
    return entry.date
  })
  pushChanged(organizationId, userId, [date])
}

export async function markChecksSeen(viewer: TimeViewer, ids: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPerson(tx, viewer.organizationId, viewer.userId)
    await tx
      .update(timeEntries)
      .set({ checkSeenAt: new Date().toISOString() })
      .where(
        and(
          eq(timeEntries.organizationId, viewer.organizationId),
          eq(timeEntries.userId, viewer.userId),
          inArray(timeEntries.id, ids),
          eq(timeEntries.needsCheck, true),
        ),
      )
  })
}

async function runningTimer(executor: Executor, organizationId: string, userId: string): Promise<TimerRow | null> {
  const [timer] = await executor
    .select()
    .from(timeTimers)
    .where(and(eq(timeTimers.organizationId, organizationId), eq(timeTimers.userId, userId)))
    .orderBy(desc(timeTimers.startedAt))
    .limit(1)
  return timer ?? null
}

/**
 * Ends the timer and logs what it ran, on the local day it started. Under a minute logs nothing, and so does a
 * locked day. It logs even when the user left the project, because the time was already spent
 */
async function closeTimer(tx: Tx, timer: TimerRow, now: Date): Promise<{ entry: Row | null; locked: boolean }> {
  const { organizationId, userId } = timer
  await tx.delete(timeTimers).where(and(eq(timeTimers.organizationId, organizationId), eq(timeTimers.userId, userId)))
  const { minutes, capped } = capTimer(timer.startedAt, now)
  if (minutes < 1) return { entry: null, locked: false }
  const [person] = await tx.select({ timeZone: users.timeZone }).from(users).where(eq(users.id, userId))
  const date = localDate(new Date(storedMs(timer.startedAt) ?? now.getTime()), person?.timeZone ?? null)
  if (isLocked({ projectId: timer.projectId, date }, await lockOf(tx, organizationId, timer.projectId))) {
    return { entry: null, locked: true }
  }
  const at = now.toISOString()
  const [entry] = await tx
    .insert(timeEntries)
    .values({
      organizationId,
      userId,
      projectId: timer.projectId,
      taskId: timer.taskId,
      date,
      minutes,
      note: timer.note,
      source: "timer",
      startedAt: timer.startedAt,
      needsCheck: capped,
      createdAt: at,
      updatedAt: at,
    })
    .returning()
  await afterEntryChange(tx, organizationId, userId, [date])
  return { entry, locked: false }
}

/** Whether the timer runs on the project, directly or on one of its tasks */
async function timerOn(tx: Tx, timer: TimerRow, projectId: string): Promise<boolean> {
  if (timer.projectId === projectId) return true
  if (!timer.taskId) return false
  // trash: a timer on a task in Trash still stops with its project
  const [task] = await tx
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(and(eq(tasks.id, timer.taskId), eq(tasks.organizationId, timer.organizationId)))
  return task?.projectId === projectId
}

/**
 * Stops the user's timer and tells their sessions. With `cappedOnly` it stops only a timer past the cap, and with
 * `onProject` only one running on that project
 */
export async function finishTimer(organizationId: string, userId: string, cappedOnly = false, now = new Date(), onProject?: string) {
  const result = await db.transaction(async (tx) => {
    await lockPerson(tx, organizationId, userId)
    const running = await runningTimer(tx, organizationId, userId)
    if (!running || (cappedOnly && !capTimer(running.startedAt, now).capped)) return null
    if (onProject && !(await timerOn(tx, running, onProject))) return null
    return closeTimer(tx, running, now)
  })
  if (!result) return null
  return { entry: await announceStopped(organizationId, userId, result.entry, result.locked), locked: result.locked }
}

async function announceStopped(organizationId: string, userId: string, row: Row | null, locked: boolean): Promise<EntryDto | null> {
  const entry = row ? await entryDto(db, organizationId, row) : null
  push(organizationId, userId, "time:timer", { timer: null, stopped: entry, ...(locked ? { stoppedLocked: true } : {}) })
  if (entry) pushChanged(organizationId, userId, [entry.date])
  return entry
}

/** The users whose timer runs on the task, or on the project directly or on one of its tasks */
export async function timingPeople(
  executor: Executor,
  organizationId: string,
  place: { taskId: string } | { projectId: string },
): Promise<string[]> {
  // trash: a timer on a task in Trash still stops with its project
  const projectTasks = (projectId: string) =>
    executor
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.organizationId, organizationId)))
  const on =
    "taskId" in place
      ? eq(timeTimers.taskId, place.taskId)
      : or(eq(timeTimers.projectId, place.projectId), inArray(timeTimers.taskId, projectTasks(place.projectId)))
  const rows = await executor
    .selectDistinct({ userId: timeTimers.userId })
    .from(timeTimers)
    .where(and(eq(timeTimers.organizationId, organizationId), on))
  return rows.map((row) => row.userId)
}

/** Takes the user locks of all users timing the task, before its row lock, in the order a timer start takes them */
export async function lockTaskTimers(tx: Tx, organizationId: string, taskId: string): Promise<Set<string>> {
  const people = (await timingPeople(tx, organizationId, { taskId })).sort()
  for (const userId of people) await lockPerson(tx, organizationId, userId)
  return new Set(people)
}

type StoppedTimer = { userId: string; entry: Row | null; locked: boolean }

/** Stops and logs every timer running on the task, as Stop does. Runs after `lockTaskTimers` and the task's row lock */
export async function stopTaskTimers(
  tx: Tx,
  organizationId: string,
  taskId: string,
  locked: Set<string>,
  now = new Date(),
): Promise<StoppedTimer[]> {
  const stopped: StoppedTimer[] = []
  for (const userId of await timingPeople(tx, organizationId, { taskId })) {
    if (!locked.has(userId)) await lockPerson(tx, organizationId, userId)
    const running = await runningTimer(tx, organizationId, userId)
    if (running?.taskId === taskId) stopped.push({ userId, ...(await closeTimer(tx, running, now)) })
  }
  return stopped
}

/**
 * Stops and logs the timers of these users that run on the project or its tasks, after the project went to Trash,
 * and tells each of them. Run after the commit, since each stop takes its user's lock
 */
export async function stopProjectTimers(organizationId: string, projectId: string, userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    try {
      await finishTimer(organizationId, userId, false, new Date(), projectId)
    } catch (error) {
      logger.warn("Stopping a timer on a project in Trash failed", {
        organizationId,
        userId,
        error: errorText(error),
      })
    }
  }
}

/** Tells each user their timer stopped, once the change that stopped it is saved */
export async function announceStoppedTimers(organizationId: string, stopped: StoppedTimer[]): Promise<void> {
  for (const { userId, entry, locked } of stopped) {
    try {
      await announceStopped(organizationId, userId, entry, locked)
    } catch (error) {
      logger.warn("Announcing a stopped timer failed", { error: errorText(error) })
    }
  }
}

export async function stopTimer(viewer: TimeViewer): Promise<{ entry: EntryDto | null; locked?: true }> {
  const result = await finishTimer(viewer.organizationId, viewer.userId)
  return result?.locked ? { entry: null, locked: true } : { entry: result?.entry ?? null }
}

/** Starting a timer while one runs stops the first and logs it */
export async function startTimer(
  viewer: TimeViewer,
  input: { projectId?: string; taskId?: string; note?: string | null },
): Promise<{ timer: TimerDto; stopped: EntryDto | null; stoppedLocked?: true }> {
  const { organizationId, userId } = viewer
  const { timer, stopped, stoppedLocked } = await db.transaction(async (tx) => {
    await lockPerson(tx, organizationId, userId)
    await refuseWhenOff(tx, organizationId)
    const place = await placeFor(tx, viewer, input)
    const now = new Date()
    const running = await runningTimer(tx, organizationId, userId)
    const closed = running ? await closeTimer(tx, running, now) : null
    const at = now.toISOString()
    const [started] = await tx
      .insert(timeTimers)
      .values({ organizationId, userId, ...place, note: input.note || null, startedAt: at, createdAt: at })
      .returning()
    // A task moved to Trash while this started holds the insert until it is saved, so it is read again
    if (place.taskId) {
      const [still] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, place.taskId), eq(tasks.organizationId, organizationId), liveTask))
      if (!still) throw new TimeRefusal(404, "Task not found")
    }
    // So is a project moved to Trash meanwhile, which held the insert the same way
    if (place.projectId) {
      const [still] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, place.projectId), eq(projects.organizationId, organizationId), liveProject))
      if (!still) throw new TimeRefusal(404, "Project not found")
    }
    return { timer: started, stopped: closed?.entry ?? null, stoppedLocked: !!closed?.locked }
  })
  const result = {
    timer: await timerDto(db, organizationId, timer),
    stopped: stopped ? await entryDto(db, organizationId, stopped) : null,
    ...(stoppedLocked ? { stoppedLocked: true as const } : {}),
  }
  push(organizationId, userId, "time:timer", result)
  if (result.stopped) pushChanged(organizationId, userId, [result.stopped.date])
  return result
}

/** The running timer. One past the cap stops itself here, marked for a check */
async function currentTimer(viewer: TimeViewer): Promise<TimerDto | null> {
  const running = await runningTimer(db, viewer.organizationId, viewer.userId)
  if (!running) return null
  if (!capTimer(running.startedAt, new Date()).capped) return timerDto(db, viewer.organizationId, running)
  await finishTimer(viewer.organizationId, viewer.userId, true)
  return null
}

/** Stops and logs the timer of a user who just left, so a timer never outlives the membership. It never fails the leaving */
export async function finishLeaversTimer(organizationId: string, userId: string, projectId?: string): Promise<void> {
  try {
    await finishTimer(organizationId, userId, false, new Date(), projectId)
  } catch (error) {
    logger.warn("Stopping a leaver's timer failed", {
      organizationId,
      userId,
      error: errorText(error),
    })
  }
}

/** Tells each user their timer is gone, after the place it ran on was deleted */
export function pushTimersGone(organizationId: string, userIds: string[]): void {
  for (const userId of new Set(userIds)) push(organizationId, userId, "time:timer", { timer: null, stopped: null })
}

/** Stops and logs every running timer in the workspace, when time tracking is switched off */
export async function stopAllTimers(organizationId: string): Promise<void> {
  const running = await db
    .selectDistinct({ userId: timeTimers.userId })
    .from(timeTimers)
    .where(eq(timeTimers.organizationId, organizationId))
  for (const { userId } of running) await finishTimer(organizationId, userId)
}

const minutesWhere = async (organizationId: string, condition: SQL | undefined) => {
  const [row] = await db
    .select({ minutes: sql<number>`coalesce(sum(${timeEntries.minutes}), 0)::int` })
    .from(timeEntries)
    .where(and(eq(timeEntries.organizationId, organizationId), condition))
  return Number(row?.minutes ?? 0)
}

/** The caller's minutes on a task, and its total on its project for that project's admins and workspace admins */
export async function taskTime(viewer: TimeViewer, taskId: string): Promise<{ mine: number; total: number | null }> {
  const { organizationId, userId } = viewer
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId), liveTask),
    columns: { id: true, projectId: true, assignedTo: true, organizationId: true, deletedAt: true },
    with: {
      project: {
        columns: { organizationId: true, deletedAt: true },
        with: { members: { where: eq(projectMembers.userId, userId), columns: { userId: true, role: true } } },
      },
    },
  })
  if (!task || !taskAccessLevel(task, userId, organizationId, viewer.isOrgAdmin)) throw new TimeRefusal(404, "Task not found")
  const mine = await minutesWhere(organizationId, and(eq(timeEntries.userId, userId), eq(timeEntries.taskId, task.id)))
  const { projectId } = task
  const seesTotal = !!projectId && (viewer.isOrgAdmin || !!task.project?.members?.some((member) => member.role === "admin"))
  const total = seesTotal
    ? await minutesWhere(organizationId, and(eq(timeEntries.taskId, task.id), eq(timeEntries.projectId, projectId)))
    : null
  return { mine, total }
}

/** Turning auto-fill on, from off, starts it today */
export async function saveTimeSettings(
  viewer: TimeViewer,
  autofillProjectId: string | null,
): Promise<{ autofillProjectId: string | null }> {
  const { organizationId, userId } = viewer
  if (autofillProjectId) await placeFor(db, viewer, { projectId: autofillProjectId })
  await db.transaction(async (tx) => {
    await lockPerson(tx, organizationId, userId)
    const [person] = await tx
      .select({ projectId: users.timeAutofillProjectId, timeZone: users.timeZone })
      .from(users)
      .where(eq(users.id, userId))
    const turnedOn = !person?.projectId && !!autofillProjectId
    await tx
      .update(users)
      .set({
        timeAutofillProjectId: autofillProjectId,
        ...(turnedOn ? { timeAutofillSince: localDate(new Date(), person?.timeZone ?? null) } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, userId))
  })
  return { autofillProjectId }
}

const CHECKS_SHOWN = 50

type TimeState =
  { enabled: false } | { enabled: true; timer: TimerDto | null; autofillProjectId: string | null; canReport: boolean; checks: EntryDto[] }

export async function timeState(viewer: TimeViewer): Promise<TimeState> {
  const { organizationId, userId } = viewer
  if (!(await timeTrackingOn(organizationId))) return { enabled: false }
  const timer = await currentTimer(viewer)
  const [person] = await db.select({ autofillProjectId: users.timeAutofillProjectId }).from(users).where(eq(users.id, userId))
  const canReport = viewer.isOrgAdmin || (await adminProjectIds(db, viewer)).size > 0
  const rows = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        eq(timeEntries.userId, userId),
        eq(timeEntries.needsCheck, true),
        isNull(timeEntries.checkSeenAt),
      ),
    )
    .orderBy(desc(timeEntries.date))
    .limit(CHECKS_SHOWN)
  return {
    enabled: true,
    timer,
    autofillProjectId: person?.autofillProjectId ?? null,
    canReport,
    checks: await entryDtos(db, organizationId, userId, rows),
  }
}
