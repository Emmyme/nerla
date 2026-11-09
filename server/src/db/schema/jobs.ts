import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex, jsonb, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

/** Background work, added in the same transaction as the data it belongs to. See src/jobs/queue.ts */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").default("pending").notNull(),
    runAt: timestamp("run_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "string" }),
    uniqueKey: text("unique_key"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    check("jobs_status_check", sql`${table.status} in ('pending', 'running', 'done', 'failed')`),
    index("jobs_due_idx")
      .on(table.runAt)
      .where(sql`${table.status} = 'pending'`),
    index("jobs_running_idx")
      .on(table.lockedUntil)
      .where(sql`${table.status} = 'running'`),
    uniqueIndex("jobs_unique_key_idx")
      .on(table.uniqueKey)
      .where(sql`${table.status} in ('pending', 'running')`),
  ],
)
