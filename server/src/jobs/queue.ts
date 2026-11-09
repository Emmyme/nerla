import { sql } from "drizzle-orm"
import type postgres from "postgres"
import { db, type Tx } from "../db"
import { logger } from "../utils/logger"
import { errorText } from "../utils/errorText"

type Db = typeof db
type Handler = (payload: unknown, job: { id: string; attempt: number }) => Promise<void>
type Claimed = { id: string; kind: string; payload: unknown; attempts: number; maxAttempts: number }

const CHANNEL = "nerla_jobs"
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_CONCURRENCY = 2
const DEFAULT_POLL_MS = 5000
const PRUNE_MS = 60 * 60 * 1000

const handlers = new Map<string, { maxAttempts: number; leaseMs: number; handler: Handler }>()

/** Thrown by a handler when trying again can't help, so the job fails at once */
export class FinalError extends Error {}

export function defineJob<P>(
  kind: string,
  options: { maxAttempts?: number; leaseMs?: number },
  handler: (payload: P, job: { id: string; attempt: number }) => Promise<void>,
): void {
  handlers.set(kind, {
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    handler: handler as Handler,
  })
}

/** Adds a job in the caller's transaction, so it exists only if the data it belongs to does. Null when its unique key is taken */
export async function addJob(
  db: Db | Tx,
  kind: string,
  payload: object,
  options: { runAt?: Date; uniqueKey?: string; maxAttempts?: number } = {},
): Promise<string | null> {
  const maxAttempts = options.maxAttempts ?? handlers.get(kind)?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const rows = await db.execute<{ id: string }>(sql`
    insert into jobs (kind, payload, run_at, unique_key, max_attempts)
    values (${kind}, ${JSON.stringify(payload)}::jsonb, coalesce(${options.runAt?.toISOString() ?? null}::timestamptz, now()),
      ${options.uniqueKey ?? null}, ${maxAttempts})
    on conflict (unique_key) where status in ('pending', 'running') do nothing
    returning id`)
  if (rows.length === 0) return null
  await db.execute(sql`select pg_notify(${CHANNEL}, '')`)
  return rows[0].id
}

/** Deletes the pending jobs with this key. A running one is left to finish */
export async function cancelJobs(db: Db | Tx, uniqueKey: string): Promise<number> {
  const rows = await db.execute(sql`delete from jobs where unique_key = ${uniqueKey} and status = 'pending' returning id`)
  return rows.length
}

// A due pending job, or a running one whose worker stopped renewing its lease
async function claim(client: postgres.Sql): Promise<Claimed | null> {
  const leases = JSON.stringify(Object.fromEntries([...handlers].map(([kind, { leaseMs }]) => [kind, leaseMs])))
  const [job] = await client<Claimed[]>`
    update jobs set status = 'running', attempts = attempts + 1,
      locked_until = now() + coalesce((${leases}::text::jsonb ->> kind)::int, ${DEFAULT_LEASE_MS}) * interval '1 millisecond'
    where id = (
      select id from jobs
      where (status = 'pending' and run_at <= now()) or (status = 'running' and locked_until < now())
      order by run_at
      limit 1
      for update skip locked
    )
    returning id, kind, payload, attempts, max_attempts as "maxAttempts"`
  return job ?? null
}

// Every write after the claim matches its attempt, so a worker whose lease ran out never overwrites the next one
async function fail(client: postgres.Sql, job: Claimed, error: string) {
  await client`
    update jobs set status = 'failed', finished_at = now(), locked_until = null, last_error = ${error}
    where id = ${job.id} and attempts = ${job.attempts} and status = 'running'`
  logger.warn(`Job ${job.kind} failed for good: ${error}`, { kind: job.kind, attempts: job.attempts })
}

async function retry(client: postgres.Sql, job: Claimed, error: string) {
  await client`
    update jobs set status = 'pending', locked_until = null, last_error = ${error},
      run_at = now() + least(interval '30 seconds' * power(2, attempts - 1), interval '1 hour') * (1 + random() * 0.1)
    where id = ${job.id} and attempts = ${job.attempts} and status = 'running'`
}

async function finish(client: postgres.Sql, job: Claimed) {
  await client`
    update jobs set status = 'done', finished_at = now(), locked_until = null
    where id = ${job.id} and attempts = ${job.attempts} and status = 'running'`
}

async function execute(client: postgres.Sql, job: Claimed) {
  const definition = handlers.get(job.kind)
  if (!definition) return fail(client, job, `No handler for ${job.kind}. This server may be older than the one that added it.`)
  if (job.attempts > job.maxAttempts) {
    return fail(client, job, "The server stopped while this job ran its last attempt. Check the server log for a crash at that time.")
  }
  const { leaseMs, handler } = definition
  const heartbeat = setInterval(() => {
    client`
      update jobs set locked_until = now() + ${leaseMs} * interval '1 millisecond'
      where id = ${job.id} and attempts = ${job.attempts} and status = 'running'`.catch((error) =>
      logger.warn(`Job ${job.kind} could not renew its lease`, { kind: job.kind, error: errorText(error) }),
    )
  }, leaseMs / 3)
  heartbeat.unref()
  let error: string | null = null
  let final = job.attempts >= job.maxAttempts
  try {
    await handler(job.payload, { id: job.id, attempt: job.attempts })
  } catch (thrown) {
    error = errorText(thrown)
    final ||= thrown instanceof FinalError
  } finally {
    clearInterval(heartbeat)
  }
  if (error === null) await finish(client, job)
  else if (final) await fail(client, job, error)
  else await retry(client, job, error)
}

// Never rejects. A result that could not be saved leaves the job running, and it runs again after its lease
async function run(client: postgres.Sql, job: Claimed) {
  try {
    await execute(client, job)
  } catch (error) {
    logger.warn(`Job ${job.kind} ran but its result could not be saved. It runs again after its lease`, {
      kind: job.kind,
      error: errorText(error),
    })
  }
}

/** Runs every due job and returns how many ran. For tests and the CLI */
export async function runDueJobs(options: { client?: postgres.Sql } = {}): Promise<number> {
  const client = options.client ?? db.$client
  let count = 0
  for (let job = await claim(client); job; job = await claim(client)) {
    await run(client, job)
    count++
  }
  return count
}

async function prune(client: postgres.Sql) {
  await client`
    delete from jobs
    where (status = 'done' and finished_at < now() - interval '7 days')
      or (status = 'failed' and finished_at < now() - interval '30 days')`
}

type Worker = {
  client: postgres.Sql
  concurrency: number
  active: Set<Promise<void>>
  stopping: boolean
  filling: Promise<void> | null
  again: boolean
  timers: NodeJS.Timeout[]
  pruning: Promise<void>
  listening: Promise<{ unlisten: () => Promise<void> } | null>
}

let worker: Worker | null = null

const unreachable = (error: unknown) => {
  logger.warn("The job worker could not reach the database. It tries again on its next poll", { error: errorText(error) })
}

// Claims jobs until every slot is busy or none is due. A wake while it claims makes it look once more
function fill(w: Worker) {
  if (w.filling) {
    w.again = true
    return
  }
  w.filling = (async () => {
    do {
      w.again = false
      while (!w.stopping && w.active.size < w.concurrency) {
        const job = await claim(w.client)
        if (!job) break
        const running: Promise<void> = run(w.client, job).finally(() => {
          w.active.delete(running)
          fill(w)
        })
        w.active.add(running)
      }
    } while (w.again && !w.stopping)
  })()
    .catch(unreachable)
    .finally(() => {
      w.filling = null
      if (w.again && !w.stopping) fill(w)
    })
}

/** Runs jobs in the background. A notify from addJob wakes it, and it polls every pollMs in case one is missed */
export function startWorker(options: { client?: postgres.Sql; concurrency?: number; pollMs?: number } = {}): void {
  if (worker) return
  const w: Worker = {
    client: options.client ?? db.$client,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    active: new Set(),
    stopping: false,
    filling: null,
    again: false,
    timers: [],
    pruning: Promise.resolve(),
    listening: Promise.resolve(null),
  }
  worker = w
  const pruneNow = () => {
    w.pruning = prune(w.client).catch(unreachable)
  }
  // The listen connection reconnects on its own and calls onlisten each time, which catches anything added meanwhile
  w.listening = w.client
    .listen(
      CHANNEL,
      () => fill(w),
      () => fill(w),
    )
    .catch((error) => {
      unreachable(error)
      return null
    })
  w.timers = [setInterval(() => fill(w), options.pollMs ?? DEFAULT_POLL_MS), setInterval(pruneNow, PRUNE_MS)]
  for (const timer of w.timers) timer.unref()
  pruneNow()
  fill(w)
}

/** Stops claiming and waits up to timeoutMs for running jobs. One still running after that runs again after its lease */
export async function stopWorker(timeoutMs = 30_000): Promise<void> {
  const w = worker
  if (!w) return
  worker = null
  w.stopping = true
  for (const timer of w.timers) clearInterval(timer)
  // A failed unlisten only matters to a process that is shutting down anyway
  const unlisten = w.listening.then((listening) => listening?.unlisten()).catch(() => {})
  let timeout: NodeJS.Timeout | undefined
  const waited = Promise.all([unlisten, w.filling, w.pruning]).then(() => Promise.all(w.active))
  const gaveUp = new Promise<boolean>((resolve) => (timeout = setTimeout(() => resolve(true), timeoutMs)))
  if (await Promise.race([waited.then(() => false), gaveUp])) {
    logger.warn(`Jobs still running when the job worker stopped: ${w.active.size}. They run again after their lease`)
  }
  clearTimeout(timeout)
}

/** For the setup check: jobs that failed in the last 7 days by kind, and how long the oldest due job has waited */
export async function jobCounts(): Promise<{
  failed: { kind: string; count: number; lastError: string }[]
  oldestPendingMs: number | null
}> {
  const client = db.$client
  const failed = await client<{ kind: string; count: number; lastError: string }[]>`
    select kind, count(*)::int as count, (array_agg(last_error order by finished_at desc))[1] as "lastError"
    from jobs f where status = 'failed' and finished_at > now() - interval '7 days'
      and finished_at > coalesce((select max(finished_at) from jobs d where d.kind = f.kind and d.status = 'done'), '-infinity')
    group by kind order by kind`
  const [{ oldest }] = await client<{ oldest: number | null }[]>`
    select (extract(epoch from now() - min(run_at)) * 1000)::float8 as oldest from jobs where status = 'pending' and run_at <= now()`
  return { failed: [...failed], oldestPendingMs: oldest === null ? null : Math.round(oldest) }
}
