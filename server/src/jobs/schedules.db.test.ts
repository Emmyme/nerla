import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { db } from "../db"
import { DAY_MS } from "../utils/eventTime"
import * as schema from "../db/schema"
import { runDueJobs } from "./queue"
import { defineSchedule, tickSchedule } from "./schedules"

const clients: postgres.Sql[] = []
// A scheduler in a process of its own, with its own connections
const scheduler = () => {
  const client = postgres(process.env.DATABASE_URL!, { onnotice: () => {}, connection: { TimeZone: "UTC" } })
  clients.push(client)
  return drizzle(client, { schema })
}

beforeEach(async () => {
  await db.execute(sql`delete from jobs`)
})

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end({ timeout: 5 })))
})

describe("schedules", () => {
  it("two schedulers run a slot once", { timeout: 30_000 }, async () => {
    const a = scheduler()
    const b = scheduler()
    const ticks = (kind: string) => Promise.all(Array.from({ length: 5 }, () => [tickSchedule(kind, a), tickSchedule(kind, b)]).flat())

    let daily = 0
    defineSchedule("test-daily", DAY_MS, async () => {
      daily++
    })
    expect((await ticks("test-daily")).filter(Boolean)).toHaveLength(1)
    await runDueJobs()
    // A slot whose run is done takes no second one
    expect((await ticks("test-daily")).filter(Boolean)).toHaveLength(0)
    await runDueJobs()
    expect(daily).toBe(1)

    let often = 0
    defineSchedule("test-often", 1000, async () => {
      often++
    })
    expect(await tickSchedule("test-often", a)).not.toBeNull()
    await runDueJobs()
    await vi.waitFor(async () => expect(await tickSchedule("test-often", b)).not.toBeNull(), { timeout: 5000, interval: 100 })
    await runDueJobs()
    expect(often).toBe(2)
  })
})
