import { and, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm"
import { projectMembers, projects, timeAutofillDays, timeEntries, users, type Executor, type Tx } from "../db"
import { WEEKDAYS, type DayHours, type WorkingHours } from "../utils/availability"
import { DAY_MS, fromWallClock, isValidTimeZone, storedMs, wallClock } from "../utils/eventTime"
import { autoFillMinutes, isLocked, localDate, type Span } from "../utils/timeRules"
import { liveProject } from "../utils/trash"
import { ownOutOfOffice } from "./calendarQueries"

type AutoFillPerson = {
  id: string
  timeZone: string | null
  workingHours: WorkingHours | null
  workBreaks: DayHours[] | null
  autofillProjectId: string | null
  autofillSince: string | null
}

type Away = { startMs: number; endMs: number; allDay: boolean }

const DAY_MINUTES = 1440
const zoneOf = (timeZone: string | null) => (timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC")
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
const dateMs = (date: string) => Date.parse(`${date}T00:00:00Z`)

export const addDays = (date: string, days: number) => new Date(dateMs(date) + days * DAY_MS).toISOString().slice(0, 10)

/** The instants a run of local days covers in a zone, from the first day's midnight to the midnight after the last */
export const localDaysRange = (first: string, last: string, timeZone: string | null) => ({
  from: fromWallClock(dateMs(first), zoneOf(timeZone)),
  to: fromWallClock(dateMs(last) + DAY_MS, zoneOf(timeZone)),
})

function windowOn(person: AutoFillPerson, date: string): Span | null {
  const hours = person.workingHours?.[WEEKDAYS[(new Date(dateMs(date)).getUTCDay() + 6) % 7]]
  return hours ? { start: minutesOf(hours.start), end: minutesOf(hours.end) } : null
}

/** A day counts once its working end has passed in the user's zone. A day off counts once it is over */
export function dayReached(person: AutoFillPerson, date: string, now: Date): boolean {
  const today = localDate(now, person.timeZone)
  if (date !== today) return date < today
  const window = windowOn(person, date)
  return !!window && fromWallClock(dateMs(date) + window.end * 60_000, zoneOf(person.timeZone)) <= now.getTime()
}

/** The user's own out of office between two local dates, read in the caller's transaction */
async function awayBetween(tx: Tx, organizationId: string, person: AutoFillPerson, first: string, last: string): Promise<Away[]> {
  const events = await ownOutOfOffice(tx, { id: person.id, organizationId }, localDaysRange(first, last, person.timeZone))
  return events.flatMap((event) => {
    const startMs = storedMs(event.startsAt)
    const endMs = storedMs(event.endsAt)
    return event.eventType === "ooo" && event.createdBy === person.id && startMs !== null && endMs !== null
      ? [{ startMs, endMs, allDay: event.allDay }]
      : []
  })
}

/** Time away clipped to one local day, in minutes since its midnight. All-day dates are read as dates */
function awayOn(away: Away[], date: string, timeZone: string | null): Span[] {
  const midnight = dateMs(date)
  const zone = zoneOf(timeZone)
  return away.flatMap((event) => {
    if (event.allDay) return event.startMs <= midnight && midnight < event.endMs ? [{ start: 0, end: DAY_MINUTES }] : []
    const start = Math.max(0, Math.floor((wallClock(event.startMs, zone) - midnight) / 60_000))
    const end = Math.min(DAY_MINUTES, Math.ceil((wallClock(event.endMs, zone) - midnight) / 60_000))
    return end > start ? [{ start, end }] : []
  })
}

/** The working window minus breaks and time away, before other time is taken off */
const freeMinutes = (person: AutoFillPerson, date: string, away: Away[]) =>
  autoFillMinutes({
    window: windowOn(person, date),
    breaks: (person.workBreaks ?? []).map((part) => ({ start: minutesOf(part.start), end: minutesOf(part.end) })),
    away: awayOn(away, date, person.timeZone),
    otherMinutes: 0,
  })

async function personOf(executor: Executor, userId: string): Promise<AutoFillPerson | null> {
  const [person] = await executor
    .select({
      id: users.id,
      timeZone: users.timeZone,
      workingHours: users.workingHours,
      workBreaks: users.workBreaks,
      autofillProjectId: users.timeAutofillProjectId,
      autofillSince: users.timeAutofillSince,
    })
    .from(users)
    .where(eq(users.id, userId))
  return person ?? null
}

async function isMemberOf(tx: Tx, organizationId: string, userId: string, projectId: string): Promise<boolean> {
  const [row] = await tx
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        eq(projects.organizationId, organizationId),
        liveProject,
      ),
    )
    .limit(1)
  return !!row
}

/** The project's lock date, under a share lock so a lock being set waits for the write */
export async function lockedUntilOf(tx: Tx, organizationId: string, projectId: string): Promise<string | null> {
  // trash: a lock date holds whether or not the project is in Trash
  const [project] = await tx
    .select({ lockedUntil: projects.timeLockedUntil })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
    .for("share")
  return project?.lockedUntil ?? null
}

/** An auto entry the user edited is ordinary logged time */
const untouchedAuto = and(eq(timeEntries.source, "auto"), eq(timeEntries.autoEdited, false))

/** Minutes the user logged that day other than auto-fill */
async function otherMinutes(tx: Tx, organizationId: string, userId: string, date: string): Promise<number> {
  const [row] = await tx
    .select({ minutes: sql<number>`coalesce(sum(${timeEntries.minutes}), 0)::int` })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        eq(timeEntries.userId, userId),
        eq(timeEntries.date, date),
        or(ne(timeEntries.source, "auto"), eq(timeEntries.autoEdited, true)),
      ),
    )
  return Number(row?.minutes ?? 0)
}

const autoEntryWhere = (organizationId: string, userId: string, date: string) =>
  and(eq(timeEntries.organizationId, organizationId), eq(timeEntries.userId, userId), eq(timeEntries.date, date), untouchedAuto)

/** Recomputes the day's auto entry, unless it is locked or read-only, or there is none the user left as it was */
export async function refreshAutoFill(tx: Tx, organizationId: string, userId: string, date: string): Promise<void> {
  const [entry] = await tx
    .select()
    .from(timeEntries)
    .where(autoEntryWhere(organizationId, userId, date))
    .limit(1)
    .for("update")
  if (!entry || entry.detachedAt || !entry.projectId) return
  if (isLocked(entry, await lockedUntilOf(tx, organizationId, entry.projectId))) return
  if (!(await isMemberOf(tx, organizationId, userId, entry.projectId))) return
  const person = await personOf(tx, userId)
  if (!person) return
  const away = await awayBetween(tx, organizationId, person, date, date)
  const minutes = Math.max(0, freeMinutes(person, date, away) - (await otherMinutes(tx, organizationId, userId, date)))
  if (minutes === entry.minutes) return
  await tx
    .update(timeEntries)
    .set({ minutes, updatedAt: new Date().toISOString() })
    .where(and(eq(timeEntries.id, entry.id), eq(timeEntries.organizationId, organizationId)))
}

/** The dates among `dates` auto-fill already filled */
export async function filledDays(executor: Executor, organizationId: string, userId: string, dates: string[]): Promise<Set<string>> {
  if (dates.length === 0) return new Set()
  const rows = await executor
    .select({ date: timeAutofillDays.date })
    .from(timeAutofillDays)
    .where(
      and(eq(timeAutofillDays.organizationId, organizationId), eq(timeAutofillDays.userId, userId), inArray(timeAutofillDays.date, dates)),
    )
  return new Set(rows.map((row) => row.date))
}

/**
 * Fills the days not filled yet, under the user lock the caller holds. Each gets one record, and at most one auto
 * entry on the user's auto-fill project while they are still in it. A locked day is recorded with no entry
 */
export async function fillDays(
  tx: Tx,
  organizationId: string,
  userId: string,
  dates: string[],
): Promise<{ recorded: number; changed: string[] }> {
  const none = { recorded: 0, changed: [] }
  const person = await personOf(tx, userId)
  const projectId = person?.autofillProjectId
  if (!person || !projectId || !person.autofillSince) return none
  const since = person.autofillSince
  const known = await filledDays(tx, organizationId, userId, dates)
  const open = [...new Set(dates)].filter((date) => date >= since && !known.has(date)).sort()
  if (open.length === 0 || !(await isMemberOf(tx, organizationId, userId, projectId))) return none
  const lockedUntil = await lockedUntilOf(tx, organizationId, projectId)
  const away = await awayBetween(tx, organizationId, person, open[0], open[open.length - 1])
  const existing = await tx
    .select({ date: timeEntries.date })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        eq(timeEntries.userId, userId),
        untouchedAuto,
        gte(timeEntries.date, open[0]),
        lte(timeEntries.date, open[open.length - 1]),
      ),
    )
  const hasAuto = new Set(existing.map((row) => row.date))
  const at = new Date().toISOString()
  const changed: string[] = []
  for (const date of open) {
    await tx.insert(timeAutofillDays).values({ organizationId, userId, date, createdAt: at })
    if (hasAuto.has(date) || isLocked({ projectId, date }, lockedUntil)) continue
    const free = freeMinutes(person, date, away)
    if (free === 0) continue
    const minutes = Math.max(0, free - (await otherMinutes(tx, organizationId, userId, date)))
    await tx.insert(timeEntries).values({ organizationId, userId, projectId, date, minutes, source: "auto", createdAt: at, updatedAt: at })
    changed.push(date)
  }
  return { recorded: open.length, changed }
}
