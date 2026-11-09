import { setTimeout as sleep } from "node:timers/promises"
import { sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { db } from "../db"
import { logger } from "../utils/logger"
import { addJob, cancelJobs, defineJob, jobCounts, runDueJobs, startWorker, stopWorker } from "./queue"

const clients: postgres.Sql[] = []
let a: postgres.Sql
let b: postgres.Sql

const client = () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {}, connection: { TimeZone: "UTC" } })
  clients.push(sql)
  return sql
}

type Row = { status: string; attempts: number; lastError: string | null; runAt: number; delay: number }
const row = async (id: string): Promise<Row | undefined> => {
  const [found] = await db.$client<Row[]>`
    select status, attempts, last_error as "lastError", extract(epoch from run_at)::float8 as "runAt", extract(epoch from run_at - now())::float8 as delay
    from jobs where id = ${id}`
  return found
}
const makeDue = (id: string) => db.$client`update jobs set run_at = now() where id = ${id}`
// What a worker leaves behind when its process dies mid-job
const claimAndDie = (id: string) =>
  db.$client`update jobs set status = 'running', attempts = attempts + 1, locked_until = now() + interval '3 seconds' where id = ${id}`

beforeAll(async () => {
  a = client()
  b = client()
  await Promise.all([a`select 1`, b`select 1`])
})

beforeEach(async () => {
  await db.execute(sql`delete from jobs`)
})

afterEach(async () => {
  await stopWorker()
  vi.restoreAllMocks()
})

afterAll(async () => {
  await Promise.all(clients.map((sql) => sql.end({ timeout: 5 })))
})

describe("the job queue", () => {
  it("a job runs once", async () => {
    const ran: string[] = []
    const payloads: number[] = []
    defineJob<{ n: number }>("once", {}, async (payload, job) => {
      ran.push(job.id)
      payloads.push(payload.n)
      await sleep(20)
    })
    const ids = await Promise.all(Array.from({ length: 10 }, (_, n) => addJob(db, "once", { n })))
    const [byA, byB] = await Promise.all([runDueJobs({ client: a }), runDueJobs({ client: b })])
    expect(byA + byB).toBe(10)
    expect(byA).toBeGreaterThan(0)
    expect(byB).toBeGreaterThan(0)
    expect([...ran].sort()).toEqual([...ids].sort())
    expect(payloads.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(await db.$client`select 1 from jobs where status <> 'done'`).toHaveLength(0)
  })

  it("a job whose worker dies runs again after its lease", { timeout: 15_000 }, async () => {
    const attempts: number[] = []
    defineJob("crashy", { leaseMs: 1000 }, async (_payload, job) => {
      attempts.push(job.attempt)
    })
    const id = (await addJob(db, "crashy", {}))!
    const last = (await addJob(db, "crashy", {}, { maxAttempts: 1 }))!
    await claimAndDie(id)
    await claimAndDie(last)
    expect(await runDueJobs({ client: a })).toBe(0)
    // Polled rather than slept, so a loaded machine only makes it wait longer
    let ran = 0
    await vi.waitFor(
      async () => {
        ran += await runDueJobs({ client: b })
        expect(ran).toBe(2)
      },
      { timeout: 10_000, interval: 250 },
    )
    expect(attempts).toEqual([2])
    expect(await row(id)).toMatchObject({ status: "done", attempts: 2 })
    // A job that took the server down on its last attempt is not run again
    expect(await row(last)).toMatchObject({ status: "failed", attempts: 2, lastError: expect.stringContaining("server stopped") })
  })

  it("a running job keeps its lease", { timeout: 30_000 }, async () => {
    // A lease long enough that a heartbeat late under a loaded machine still renews it in time
    let starts = 0
    defineJob("slow", { leaseMs: 3000 }, async () => {
      starts++
      await sleep(7000)
    })
    await addJob(db, "slow", {})
    let finished = false
    const first = runDueJobs({ client: a }).finally(() => (finished = true))
    await vi.waitFor(() => expect(starts).toBe(1), { timeout: 5000 })
    let stolen = 0
    // Until the job ends, which is more than twice its lease
    while (!finished) {
      stolen += await runDueJobs({ client: b })
      await sleep(200)
    }
    expect(await first).toBe(1)
    expect(stolen).toBe(0)
    expect(starts).toBe(1)
  })

  it("a worker whose job was taken over writes nothing back", async () => {
    // Another worker claiming the job after a lapsed lease bumps attempts, as this does
    const takeOver = (id: string) => db.$client`update jobs set attempts = attempts + 1 where id = ${id}`
    defineJob("overtaken", {}, async (_payload, job) => {
      await takeOver(job.id)
    })
    defineJob("overtaken-fails", {}, async (_payload, job) => {
      await takeOver(job.id)
      throw new Error("Too late")
    })
    const done = (await addJob(db, "overtaken", {}))!
    const retried = (await addJob(db, "overtaken-fails", {}))!
    const failed = (await addJob(db, "overtaken-fails", {}, { maxAttempts: 1 }))!
    expect(await runDueJobs()).toBe(3)
    expect(await row(done)).toMatchObject({ status: "running", attempts: 2 })
    expect(await row(retried)).toMatchObject({ status: "running", attempts: 2, lastError: null })
    expect(await row(failed)).toMatchObject({ status: "running", attempts: 2, lastError: null })
  })

  it("a failing job backs off, then fails for good", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(logger)
    let calls = 0
    defineJob("always-fails", {}, async () => {
      calls++
      throw new Error("The mail server said no")
    })
    const id = (await addJob(db, "always-fails", {}, { maxAttempts: 3 }))!
    const unknown = (await addJob(db, "nobody-knows", {}))!

    expect(await runDueJobs()).toBe(2)
    const first = (await row(id))!
    expect(first).toMatchObject({ status: "pending", attempts: 1, lastError: "The mail server said no" })
    expect(first.delay).toBeGreaterThan(29)
    expect(first.delay).toBeLessThan(34)

    await makeDue(id)
    await runDueJobs()
    const second = (await row(id))!
    expect(second).toMatchObject({ status: "pending", attempts: 2 })
    expect(second.runAt).toBeGreaterThan(first.runAt)
    expect(second.delay).toBeGreaterThan(59)
    expect(second.delay).toBeLessThan(67)

    await makeDue(id)
    await runDueJobs()
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 3, lastError: "The mail server said no" })
    expect(calls).toBe(3)
    expect(await row(unknown)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "No handler for nobody-knows. This server may be older than the one that added it.",
    })
    expect(warn).toHaveBeenCalledTimes(2)
    // A failure from more than a week ago no longer counts
    await db.$client`
      insert into jobs (kind, payload, status, attempts, last_error, finished_at)
      values ('always-fails', '{}', 'failed', 3, 'Long ago', now() - interval '8 days')`
    expect((await jobCounts()).failed).toEqual([
      { kind: "always-fails", count: 1, lastError: "The mail server said no" },
      { kind: "nobody-knows", count: 1, lastError: "No handler for nobody-knows. This server may be older than the one that added it." },
    ])
    // A kind that has worked since its failures is fixed
    await db.$client`insert into jobs (kind, payload, status, attempts, finished_at) values ('nobody-knows', '{}', 'done', 1, now())`
    expect((await jobCounts()).failed).toEqual([{ kind: "always-fails", count: 1, lastError: "The mail server said no" }])
  })

  it("a unique key keeps one at a time", async () => {
    defineJob("keyed", {}, async () => {})
    const added = await Promise.all(Array.from({ length: 5 }, () => addJob(db, "keyed", {}, { uniqueKey: "invite:1" })))
    expect(added.filter(Boolean)).toHaveLength(1)
    expect(await db.$client`select 1 from jobs where unique_key = 'invite:1'`).toHaveLength(1)
    await runDueJobs()
    expect(await addJob(db, "keyed", {}, { uniqueKey: "invite:1" })).not.toBeNull()
  })

  it("cancelling a pending keyed job means it never runs, and a running one is left alone", async () => {
    let calls = 0
    defineJob("expiry", {}, async () => {
      calls++
    })
    await addJob(db, "expiry", {}, { uniqueKey: "status:1" })
    const running = (await addJob(db, "expiry", {}, { uniqueKey: "status:2" }))!
    await claimAndDie(running)
    expect(await cancelJobs(db, "status:1")).toBe(1)
    expect(await cancelJobs(db, "status:2")).toBe(0)
    expect(await runDueJobs()).toBe(0)
    expect(calls).toBe(0)
    expect(await row(running)).toMatchObject({ status: "running" })
  })

  it("a delayed job waits", { timeout: 15_000 }, async () => {
    let calls = 0
    defineJob("later", {}, async () => {
      calls++
    })
    await addJob(db, "later", {}, { runAt: new Date(Date.now() + 2000) })
    expect(await runDueJobs()).toBe(0)
    expect((await jobCounts()).oldestPendingMs).toBeNull()
    await sleep(2200)
    expect((await jobCounts()).oldestPendingMs).toBeGreaterThanOrEqual(0)
    expect(await runDueJobs()).toBe(1)
    expect(calls).toBe(1)
    expect((await jobCounts()).oldestPendingMs).toBeNull()
  })

  it("a job added in a rolled-back transaction never exists", async () => {
    defineJob("ghost", {}, async () => {})
    await expect(
      db.transaction(async (tx) => {
        await addJob(tx, "ghost", {})
        throw new Error("Saving the invite failed")
      }),
    ).rejects.toThrow("Saving the invite failed")
    expect(await db.$client`select 1 from jobs`).toHaveLength(0)
    expect(await runDueJobs()).toBe(0)
  })

  it("a notify wakes the worker", async () => {
    let calls = 0
    defineJob("woken", {}, async () => {
      calls++
    })
    startWorker({ client: client(), pollMs: 60_000 })
    await vi.waitFor(
      async () =>
        expect(
          await db.$client`select 1 from pg_stat_activity where datname = current_database() and query ilike 'listen%nerla_jobs%'`,
        ).toHaveLength(1),
      { timeout: 5000 },
    )
    // The claims the worker makes as it starts are over, so only the notify can wake it
    await sleep(500)
    await addJob(db, "woken", {})
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 2000 })
  })

  it("stopping waits for a running job", { timeout: 15_000 }, async () => {
    const events: string[] = []
    defineJob("finishing", {}, async () => {
      events.push("started")
      await sleep(1000)
      events.push("finished")
    })
    startWorker({ client: client(), pollMs: 60_000, concurrency: 1 })
    const running = (await addJob(db, "finishing", {}))!
    await vi.waitFor(() => expect(events).toEqual(["started"]), { timeout: 5000 })
    const queued = (await addJob(db, "finishing", {}))!
    const stopped = stopWorker().then(() => events.push("stopped"))
    const late = (await addJob(db, "finishing", {}))!
    await stopped
    expect(events).toEqual(["started", "finished", "stopped"])
    expect(await row(running)).toMatchObject({ status: "done" })
    expect(await row(queued)).toMatchObject({ status: "pending" })
    expect(await row(late)).toMatchObject({ status: "pending" })
  })

  it("stopping gives up on a stuck job after its timeout", async () => {
    let release = () => {}
    defineJob("stuck", {}, () => new Promise<void>((resolve) => (release = resolve)))
    startWorker({ client: client(), pollMs: 60_000 })
    const id = (await addJob(db, "stuck", {}))!
    await vi.waitFor(async () => expect(await row(id)).toMatchObject({ status: "running" }), { timeout: 5000 })
    const started = Date.now()
    await stopWorker(300)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(await row(id)).toMatchObject({ status: "running" })
    release()
  })

  it("old finished jobs are pruned", async () => {
    const [doneOld, doneNew, failedOld, failedNew] = await db.$client<{ id: string }[]>`
      insert into jobs (kind, payload, status, finished_at) values
        ('old', '{}', 'done', now() - interval '8 days'),
        ('old', '{}', 'done', now() - interval '1 day'),
        ('old', '{}', 'failed', now() - interval '31 days'),
        ('old', '{}', 'failed', now() - interval '8 days')
      returning id`
    startWorker({ client: client(), pollMs: 60_000 })
    await vi.waitFor(async () => expect(await row(doneOld.id)).toBeUndefined(), { timeout: 5000 })
    expect(await row(failedOld.id)).toBeUndefined()
    expect(await row(doneNew.id)).toBeDefined()
    expect(await row(failedNew.id)).toBeDefined()
  })
})
