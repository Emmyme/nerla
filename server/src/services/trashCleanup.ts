import { and, asc, eq, gt, isNotNull, lt, sql } from "drizzle-orm"
import { calendarEvents, db, projects } from "../db"
import { logger } from "../utils/logger"
import { DAY_MS } from "../utils/eventTime"
import { TRASH_DAYS } from "../utils/trash"
import { purgeEvent } from "./calendarQueries"
import { purgeProject } from "./projectTrash"
import { purgeTask } from "./taskTrash"
import { errorText } from "../utils/errorText"

const BATCH = 200

type Due = { id: string; organizationId: string }
export type PurgeTally = { purged: number; failed: number }

/** The moment `TRASH_DAYS` before `now`, as the timestamps are stored */
const cutoffOf = (now: Date) => new Date(now.getTime() - TRASH_DAYS * DAY_MS).toISOString().replace("T", " ").replace("Z", "")

/**
 * Purges what `next` finds due, a batch at a time in id order. Each item stands alone, so one failure is logged and
 * tried again on the next run, and its delete checks the cutoff again, so an item restored meanwhile survives
 */
async function purgeEach(
  kind: string,
  next: (after: string | null) => Promise<Due[]>,
  purge: (row: Due) => Promise<boolean>,
): Promise<PurgeTally> {
  const tally: PurgeTally = { purged: 0, failed: 0 }
  let after: string | null = null
  for (;;) {
    const rows = await next(after)
    for (const row of rows) {
      try {
        if (await purge(row)) tally.purged++
      } catch (error) {
        tally.failed++
        logger.warn("Trash cleanup could not purge an item", {
          kind,
          id: row.id,
          error: errorText(error),
        })
      }
    }
    if (rows.length < BATCH) return tally
    after = rows[rows.length - 1].id
  }
}

/** Projects past their 30 days, each with everything that went with it and what of it was trashed on its own */
export function purgeDueProjects(now: Date): Promise<PurgeTally> {
  const cutoff = cutoffOf(now)
  return purgeEach(
    "project",
    (after) =>
      // tenancy: the job works across every workspace on purpose
      // trash: the purge reads projects in Trash
      db
        .select({ id: projects.id, organizationId: projects.organizationId })
        .from(projects)
        .where(and(isNotNull(projects.deletedAt), lt(projects.deletedAt, cutoff), after ? gt(projects.id, after) : undefined))
        .orderBy(asc(projects.id))
        .limit(BATCH),
    (row) => purgeProject(row.id, row.organizationId, { trashedBefore: cutoff }),
  )
}

/** Tasks trashed on their own past their 30 days. A project's own tasks go with the project */
export function purgeDueTasks(now: Date): Promise<PurgeTally> {
  const cutoff = cutoffOf(now)
  return purgeEach(
    "task",
    async (after) =>
      // tenancy: the job works across every workspace on purpose
      // trash: the purge reads tasks in Trash
      (
        await db.execute<Due>(sql`
          select t.id, t.organization_id as "organizationId"
          from tasks t
          where t.deleted_at is not null and t.deleted_at < ${cutoff}::timestamp and t.trash_root is null
            and (${after}::uuid is null or t.id > ${after}::uuid)
          order by t.id
          limit ${BATCH}::int`)
      ).map((row) => ({ id: row.id, organizationId: row.organizationId })),
    (row) => purgeTask(row.id, row.organizationId, { trashedBefore: cutoff, allowed: (task) => !task.trashRoot }),
  )
}

/** Event entries past their 30 days. An occurrence only leaves Trash while its series still skips it */
export function purgeDueEvents(now: Date): Promise<PurgeTally> {
  const cutoff = cutoffOf(now)
  return purgeEach(
    "event",
    (after) =>
      // tenancy: the job works across every workspace on purpose
      // trash: the purge reads event entries in Trash
      db
        .select({ id: calendarEvents.id, organizationId: calendarEvents.organizationId })
        .from(calendarEvents)
        .where(
          and(
            isNotNull(calendarEvents.deletedAt),
            lt(calendarEvents.deletedAt, cutoff),
            eq(calendarEvents.trashRoot, calendarEvents.id),
            after ? gt(calendarEvents.id, after) : undefined,
          ),
        )
        .orderBy(asc(calendarEvents.id))
        .limit(BATCH),
    (row) => purgeEvent(row.id, row.organizationId, { trashedBefore: cutoff }),
  )
}
