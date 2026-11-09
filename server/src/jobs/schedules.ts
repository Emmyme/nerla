import { sql } from "drizzle-orm"
import { db } from "../db"
import { logger } from "../utils/logger"
import { addJob, defineJob } from "./queue"
import { errorText } from "../utils/errorText"

type Db = typeof db

const MAX_TICK_MS = 60_000

const schedules = new Map<string, number>()
let timers: NodeJS.Timeout[] = []

/** Runs the handler once every everyMs across all processes. A slot missed while no server ran is not made up */
export function defineSchedule(kind: string, everyMs: number, handler: () => Promise<void>): void {
  defineJob(kind, {}, () => handler())
  schedules.set(kind, everyMs)
}

/** Adds the job for the slot the database clock is in. Null when the slot has one, done or not */
export async function tickSchedule(kind: string, database: Db = db): Promise<string | null> {
  const everyMs = schedules.get(kind)
  if (everyMs === undefined) throw new Error(`No schedule named ${kind}`)
  return database.transaction(async (tx) => {
    const [{ slot }] = await tx.execute<{ slot: string }>(
      sql`select floor(extract(epoch from now()) * 1000 / ${everyMs}::bigint)::bigint::text as slot`,
    )
    const uniqueKey = `${kind}:${slot}`
    // A finished run frees its unique key, so ticks take turns and look for any run of the slot
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`schedule:${uniqueKey}`}, 0))`)
    const taken = await tx.execute(sql`select 1 from jobs where unique_key = ${uniqueKey} limit 1`)
    if (taken.length > 0) return null
    return addJob(tx, kind, {}, { uniqueKey })
  })
}

/** Ticks every schedule now and then at least once a minute. Never under the tests */
export function startSchedules(): void {
  if (process.env.VITEST || timers.length > 0) return
  for (const [kind, everyMs] of schedules) {
    const tick = () =>
      tickSchedule(kind).catch((error) =>
        logger.warn(`The ${kind} schedule could not add its job. It tries again on its next tick`, {
          error: errorText(error),
        }),
      )
    void tick()
    const timer = setInterval(tick, Math.min(everyMs, MAX_TICK_MS))
    timer.unref()
    timers.push(timer)
  }
}

export function stopSchedules(): void {
  for (const timer of timers) clearInterval(timer)
  timers = []
}
