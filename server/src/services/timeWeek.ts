import { and, asc, eq, gte, inArray, isNull, lt, lte, ne } from "drizzle-orm"
import { db, projectMembers, taskActivity, taskComments, tasks, timeDismissals, timeEntries, timeMeetingProjects } from "../db"
import { msToStored, storedMs } from "../utils/eventTime"
import { canAccessTask } from "../utils/taskAccess"
import { liveTask } from "../utils/trash"
import { localDate, pickSuggestions, type SuggestionCandidate } from "../utils/timeRules"
import { listMine } from "./calendarQueries"
import { addDays, localDaysRange } from "./timeAutoFill"
import {
  lockPerson,
  meetingTitleKey,
  projectRef,
  refsOf,
  taskRef,
  taskShown,
  toEntryDto,
  type EntryDto,
  type ProjectRef,
  type TaskRef,
  type TimeViewer,
} from "./timeEntries"
import { personZone } from "./people"
import { memberProjectIds } from "./projectAccess"

type SuggestionDto = {
  key: string
  kind: "meeting" | "task" | "repeat"
  date: string
  minutes: number
  title: string
  project: ProjectRef | null
  task: TaskRef | null
  needsProject: boolean
}

type WeekDto = {
  start: string
  days: { date: string; entries: EntryDto[]; suggestions: SuggestionDto[]; minutes: number }[]
  minutes: number
  lockedUntil: Record<string, string>
}

type Candidate = SuggestionCandidate & { minutes: number; title: string; order: string }

const WEEK_DAYS = 7
const TASK_MINUTES = 30
const MAX_MINUTES = 1440
const KIND_ORDER = { meeting: 0, task: 1, repeat: 2 }

const between = (date: string, first: string, last: string) => date >= first && date <= last

async function memberProjects(viewer: TimeViewer): Promise<Set<string>> {
  const rows = await memberProjectIds(viewer.userId, viewer.organizationId)
  return new Set(rows.map((row) => row.id))
}

/** Meetings the user made or did not decline, with the project they last picked for that title */
async function meetingCandidates(viewer: TimeViewer, first: string, last: string, timeZone: string | null, members: Set<string>) {
  const { organizationId, userId } = viewer
  const events = await listMine({ id: userId, organizationId }, localDaysRange(first, last, timeZone))
  const found: Candidate[] = []
  for (const event of events) {
    if (!("created_by" in event) || event.event_type !== "meeting" || event.all_day || !event.starts_at || !event.ends_at) continue
    if (event.created_by !== userId && (!event.viewer_response || event.viewer_response === "no")) continue
    const startMs = Date.parse(event.starts_at)
    const minutes = Math.min(MAX_MINUTES, Math.round((Date.parse(event.ends_at) - startMs) / 60_000))
    const date = localDate(new Date(startMs), timeZone)
    if (minutes < 1 || !between(date, first, last)) continue
    const key = `meeting:${event.id}:${event.starts_at}`
    found.push({ key, kind: "meeting", date, minutes, title: event.title, projectId: null, taskId: null, order: event.starts_at })
  }
  const titleKeys = [...new Set(found.map((meeting) => meetingTitleKey(meeting.title)).filter(Boolean))]
  if (titleKeys.length === 0) return found
  const remembered = await db
    .select({ titleKey: timeMeetingProjects.titleKey, projectId: timeMeetingProjects.projectId })
    .from(timeMeetingProjects)
    .where(
      and(
        eq(timeMeetingProjects.organizationId, organizationId),
        eq(timeMeetingProjects.userId, userId),
        inArray(timeMeetingProjects.titleKey, titleKeys),
      ),
    )
  const projectBy = new Map(remembered.filter((row) => members.has(row.projectId)).map((row) => [row.titleKey, row.projectId]))
  return found.map((meeting) => ({ ...meeting, projectId: projectBy.get(meetingTitleKey(meeting.title)) ?? null }))
}

/** Tasks the user changed or commented on, by local day, that they can still open */
async function taskCandidates(viewer: TimeViewer, first: string, last: string, timeZone: string | null) {
  const { organizationId, userId } = viewer
  const range = localDaysRange(first, last, timeZone)
  const from = msToStored(range.from)
  const to = msToStored(range.to)
  const [changed, commented] = await Promise.all([
    db
      .select({ taskId: taskActivity.taskId, at: taskActivity.createdAt })
      .from(taskActivity)
      .where(
        and(
          eq(taskActivity.organizationId, organizationId),
          eq(taskActivity.userId, userId),
          gte(taskActivity.createdAt, from),
          lt(taskActivity.createdAt, to),
        ),
      ),
    db
      .select({ taskId: taskComments.taskId, at: taskComments.createdAt })
      .from(taskComments)
      .where(
        and(
          eq(taskComments.organizationId, organizationId),
          eq(taskComments.userId, userId),
          gte(taskComments.createdAt, from),
          lt(taskComments.createdAt, to),
        ),
      ),
  ])
  const days = new Map<string, Set<string>>()
  for (const { taskId, at } of [...changed, ...commented]) {
    const ms = storedMs(at)
    if (ms === null) continue
    const date = localDate(new Date(ms), timeZone)
    if (between(date, first, last)) days.set(taskId, (days.get(taskId) ?? new Set()).add(date))
  }
  if (days.size === 0) return []
  const found = await db.query.tasks.findMany({
    where: and(inArray(tasks.id, [...days.keys()]), eq(tasks.organizationId, organizationId), liveTask),
    columns: { id: true, title: true, projectId: true, assignedTo: true, organizationId: true, deletedAt: true },
    with: {
      project: {
        columns: { organizationId: true, deletedAt: true },
        with: { members: { where: eq(projectMembers.userId, userId), columns: { userId: true } } },
      },
    },
  })
  return found
    .filter((task) => canAccessTask(task, userId, organizationId))
    .flatMap((task) =>
      [...days.get(task.id)!].map((date): Candidate => ({
        key: `task:${task.id}:${date}`,
        kind: "task",
        date,
        minutes: TASK_MINUTES,
        title: task.title,
        projectId: task.projectId,
        taskId: task.id,
        order: task.title.toLowerCase(),
      })),
    )
}

/** The user's own time from a week earlier, on projects they are still in or on their personal tasks */
async function repeatCandidates(viewer: TimeViewer, first: string, last: string, members: Set<string>) {
  const rows = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, viewer.organizationId),
        eq(timeEntries.userId, viewer.userId),
        gte(timeEntries.date, addDays(first, -WEEK_DAYS)),
        lte(timeEntries.date, addDays(last, -WEEK_DAYS)),
        ne(timeEntries.source, "auto"),
        isNull(timeEntries.detachedAt),
      ),
    )
    .orderBy(asc(timeEntries.createdAt))
  return rows
    .filter((row) => (row.projectId ? members.has(row.projectId) : !!row.taskId))
    .map((row): Candidate => {
      const date = addDays(row.date, WEEK_DAYS)
      return {
        key: `repeat:${row.id}:${date}`,
        kind: "repeat",
        date,
        minutes: row.minutes,
        title: row.note ?? "",
        projectId: row.projectId,
        taskId: row.taskId,
        order: row.createdAt,
      }
    })
}

/** The user's own week from a Monday: entries, suggestions up to today, and the lock dates of its projects */
export async function weekOf(viewer: TimeViewer, start: string, now = new Date()): Promise<WeekDto> {
  const { organizationId, userId } = viewer
  const timeZone = await personZone(userId)
  const dates = Array.from({ length: WEEK_DAYS }, (_, offset) => addDays(start, offset))
  const end = dates[WEEK_DAYS - 1]
  const today = localDate(now, timeZone)
  const rows = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        eq(timeEntries.userId, userId),
        gte(timeEntries.date, start),
        lte(timeEntries.date, end),
      ),
    )
    .orderBy(asc(timeEntries.date), asc(timeEntries.createdAt))

  let candidates: Candidate[] = []
  if (start <= today) {
    const last = end < today ? end : today
    const members = await memberProjects(viewer)
    candidates = (
      await Promise.all([
        meetingCandidates(viewer, start, last, timeZone, members),
        taskCandidates(viewer, start, last, timeZone),
        repeatCandidates(viewer, start, last, members),
      ])
    ).flat()
  }
  const shown = rows.filter((row) => !(row.source === "auto" && row.minutes === 0))
  const refs = await refsOf(db, organizationId, userId, [...shown, ...candidates])
  // A repeat of a task the user can no longer open would name it
  candidates = candidates.filter((candidate) => candidate.kind !== "repeat" || !candidate.taskId || taskShown(refs, candidate))
  const keys = [...new Set(candidates.map((candidate) => candidate.key))]
  const [dismissed, used] = keys.length
    ? await Promise.all([
        db
          .select({ key: timeDismissals.key })
          .from(timeDismissals)
          .where(
            and(eq(timeDismissals.organizationId, organizationId), eq(timeDismissals.userId, userId), inArray(timeDismissals.key, keys)),
          ),
        db
          .select({ key: timeEntries.suggestionKey })
          .from(timeEntries)
          .where(
            and(eq(timeEntries.organizationId, organizationId), eq(timeEntries.userId, userId), inArray(timeEntries.suggestionKey, keys)),
          ),
      ])
    : [[], []]
  const seen = {
    dismissed: new Set(dismissed.map((row) => row.key)),
    usedKeys: new Set(used.flatMap((row) => (row.key ? [row.key] : []))),
    today,
  }

  const picked = new Map<string, Candidate[]>()
  for (const date of dates) {
    // An auto entry the user edited is ordinary logged time
    const logged = rows.filter((row) => row.date === date && (row.source !== "auto" || row.autoEdited))
    const unique = new Map(candidates.filter((candidate) => candidate.date === date).map((candidate) => [candidate.key, candidate]))
    const kept = pickSuggestions([...unique.values()], {
      ...seen,
      loggedTaskIds: new Set(logged.flatMap((row) => (row.taskId ? [row.taskId] : []))),
      loggedProjectIds: new Set(logged.flatMap((row) => (row.projectId ? [row.projectId] : []))),
    })
    picked.set(
      date,
      kept.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.order.localeCompare(b.order)),
    )
  }

  const suggestionDto = (candidate: Candidate): SuggestionDto => {
    const project = projectRef(refs, candidate.projectId)
    const task = taskRef(refs, candidate)
    return {
      key: candidate.key,
      kind: candidate.kind,
      date: candidate.date,
      minutes: candidate.minutes,
      title: candidate.title || task?.title || project?.name || "",
      project,
      task,
      needsProject: !project && !task,
    }
  }
  const days = dates.map((date) => {
    const entries = shown.filter((row) => row.date === date).map((row) => toEntryDto(row, refs))
    return {
      date,
      entries,
      suggestions: (picked.get(date) ?? []).map(suggestionDto),
      minutes: entries.reduce((sum, entry) => sum + entry.minutes, 0),
    }
  })
  const lockedUntil: Record<string, string> = {}
  for (const project of refs.projects.values()) if (project.lockedUntil) lockedUntil[project.id] = project.lockedUntil
  return { start, days, minutes: days.reduce((sum, day) => sum + day.minutes, 0), lockedUntil }
}

/** Hides a suggestion for good, stored once */
export async function dismissSuggestion(viewer: TimeViewer, key: string): Promise<void> {
  const { organizationId, userId } = viewer
  await db.transaction(async (tx) => {
    await lockPerson(tx, organizationId, userId)
    const [known] = await tx
      .select({ id: timeDismissals.id })
      .from(timeDismissals)
      .where(and(eq(timeDismissals.organizationId, organizationId), eq(timeDismissals.userId, userId), eq(timeDismissals.key, key)))
      .limit(1)
    if (!known) await tx.insert(timeDismissals).values({ organizationId, userId, key, createdAt: new Date().toISOString() })
  })
}
