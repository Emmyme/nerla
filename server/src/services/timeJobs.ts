import { and, eq, isNotNull, lte } from "drizzle-orm"
import { db, organizations, projects, timeTimers, users } from "../db"
import { msToStored } from "../utils/eventTime"
import { logger } from "../utils/logger"
import { localDate, MAX_TIMER_MINUTES } from "../utils/timeRules"
import { liveProject } from "../utils/trash"
import { addDays, dayReached, filledDays, fillDays } from "./timeAutoFill"
import { finishTimer, lockPerson, pushChanged } from "./timeEntries"
import { errorText } from "../utils/errorText"

const FILL_DAYS_BACK = 6

const failed = (message: string, error: unknown, extra: Record<string, unknown> = {}) =>
  logger.warn(message, { ...extra, error: errorText(error) })

/** Stops every timer past the cap in workspaces with time tracking on */
async function capTimers(now: Date): Promise<number> {
  // tenancy: the job works across every workspace with time tracking on, on purpose
  const due = await db
    .selectDistinct({ organizationId: timeTimers.organizationId, userId: timeTimers.userId })
    .from(timeTimers)
    .innerJoin(organizations, and(eq(organizations.id, timeTimers.organizationId), eq(organizations.timeTracking, true)))
    .where(lte(timeTimers.startedAt, msToStored(now.getTime() - MAX_TIMER_MINUTES * 60_000)))
  let capped = 0
  for (const { organizationId, userId } of due) {
    try {
      if (await finishTimer(organizationId, userId, true, now)) capped++
    } catch (error) {
      failed("Capping a timer failed", error, { organizationId, userId })
    }
  }
  return capped
}

/** Fills the days each user with auto-fill on has reached, from the day it was turned on and at most a week back */
async function autoFill(now: Date): Promise<number> {
  // tenancy: the job works across every workspace with time tracking on, on purpose
  const people = await db
    .select({
      organizationId: projects.organizationId,
      id: users.id,
      timeZone: users.timeZone,
      workingHours: users.workingHours,
      workBreaks: users.workBreaks,
      autofillProjectId: users.timeAutofillProjectId,
      autofillSince: users.timeAutofillSince,
    })
    .from(users)
    .innerJoin(projects, eq(projects.id, users.timeAutofillProjectId))
    .innerJoin(organizations, and(eq(organizations.id, projects.organizationId), eq(organizations.timeTracking, true)))
    .where(and(isNotNull(users.timeAutofillSince), liveProject))
  let filled = 0
  for (const { organizationId, ...person } of people) {
    try {
      const today = localDate(now, person.timeZone)
      const since = person.autofillSince!
      const dates: string[] = []
      for (let date = addDays(today, -FILL_DAYS_BACK); date <= today; date = addDays(date, 1)) {
        if (date >= since && dayReached(person, date, now)) dates.push(date)
      }
      const known = await filledDays(db, organizationId, person.id, dates)
      const open = dates.filter((date) => !known.has(date))
      if (open.length === 0) continue
      const result = await db.transaction(async (tx) => {
        await lockPerson(tx, organizationId, person.id)
        return fillDays(tx, organizationId, person.id, open)
      })
      filled += result.recorded
      if (result.changed.length) pushChanged(organizationId, person.id, result.changed)
    } catch (error) {
      failed("Auto-fill failed", error, { organizationId, userId: person.id })
    }
  }
  return filled
}

/**
 * The time-jobs job, every 15 minutes: caps forgotten timers and fills reached days. Two runs can overlap when one
 * outlasts its slot, which is safe, since each user's change happens under their lock and checks again what is left
 */
export async function runTimeJobs(now: Date = new Date()): Promise<void> {
  const result = { capped: await capTimers(now), filled: await autoFill(now) }
  if (result.capped || result.filled) logger.info("Time jobs finished", result)
}
