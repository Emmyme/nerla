import { sql } from "drizzle-orm"
import { db } from "../db"
import { logger } from "../utils/logger"
import { sweepHeld } from "./aiCards"
import { errorText } from "../utils/errorText"

const KEEP_DAYS = 90

/** Deletes notifications older than 90 days and returns how many went */
async function runNotificationCleanup(now: Date = new Date()): Promise<number> {
  // tenancy: the job works across every workspace on purpose
  const gone = await db.execute(sql`
    delete from notifications
    where created_at <= ((${now.toISOString()}::timestamptz at time zone 'utc') - make_interval(days => ${KEEP_DAYS}::int))`)
  return gone.count
}

/** The daily notification-cleanup job, which also expires unanswered Allow cards. Either failing fails the job */
export async function notificationCleanupJob(): Promise<void> {
  const [removed, expired] = await Promise.allSettled([runNotificationCleanup(), sweepHeld()])
  if (removed.status === "fulfilled" && removed.value > 0) logger.info("Notification cleanup finished", { removed: removed.value })
  const failures = [
    removed.status === "rejected" && `Deleting old notifications failed: ${errorText(removed.reason)}`,
    expired.status === "rejected" && `Expiring Allow cards failed: ${errorText(expired.reason)}`,
  ].filter(Boolean)
  if (failures.length > 0) throw new Error(failures.join(" "))
}
