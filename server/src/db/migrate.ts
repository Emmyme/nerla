import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type postgres from "postgres"
import { loadEnvFile, resolveSecretFiles } from "../config"
import { errorText } from "../utils/errorText"

// Two levels up from both src/db and dist/db
export const MIGRATIONS_DIR = resolve(__dirname, "../../drizzle")

const BREAKPOINT = "--> statement-breakpoint"
const NO_TRANSACTION = "-- nerla:no-transaction"
const REINSTALL = "Reinstall this version of Nerla so its drizzle folder is complete."

export class MigrationError extends Error {
  name = "MigrationError"

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

interface Migration {
  name: string
  hash: string
  statements: string[]
  transaction: boolean
}

interface Options {
  dir?: string
  log?: (line: string) => void
}

async function readMigrations(dir: string): Promise<Migration[]> {
  const journalPath = join(dir, "meta", "_journal.json")
  let tags: string[]
  try {
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] }
    tags = journal.entries.map((entry) => entry.tag)
  } catch (error) {
    throw new MigrationError(`The migration list ${journalPath} is missing or unreadable. ${REINSTALL}`, error)
  }
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).map((file) => file.slice(0, -".sql".length))
  const unlisted = files.find((file) => !tags.includes(file))
  if (unlisted) {
    throw new MigrationError(
      `Migration ${unlisted}.sql is not in ${journalPath}. Remove the stray file, or generate it again with drizzle-kit generate.`,
    )
  }
  return Promise.all(
    tags.map(async (name) => {
      if (!files.includes(name))
        throw new MigrationError(`Migration ${name} is listed in ${journalPath} but its file is missing. ${REINSTALL}`)
      const text = (await readFile(join(dir, `${name}.sql`), "utf8")).replace(/\r\n/g, "\n")
      return {
        name,
        hash: createHash("sha256").update(text).digest("hex"),
        statements: text
          .split(BREAKPOINT)
          .map((statement) => statement.trim())
          .filter(Boolean),
        transaction: text.split("\n", 1)[0].trim() !== NO_TRANSACTION,
      }
    }),
  )
}

async function appliedHashes(conn: postgres.Sql | postgres.ReservedSql): Promise<Map<string, string>> {
  const [{ exists }] = await conn<{ exists: boolean }[]>`select to_regclass('nerla_migrations') is not null as exists`
  if (!exists) return new Map()
  const rows = await conn<{ name: string; hash: string }[]>`select name, hash from nerla_migrations`
  return new Map(rows.map((row) => [row.name, row.hash]))
}

export async function pendingMigrations(sql: postgres.Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  const applied = await appliedHashes(sql)
  return (await readMigrations(dir)).filter((migration) => !applied.has(migration.name)).map((migration) => migration.name)
}

async function apply(conn: postgres.ReservedSql, migration: Migration) {
  const record = () => conn`insert into nerla_migrations (name, hash) values (${migration.name}, ${migration.hash})`
  if (!migration.transaction) {
    for (const statement of migration.statements) await conn.unsafe(statement)
    await record()
    return
  }
  // A reserved connection has no begin of its own, and every query here runs on that one connection
  await conn`begin`
  try {
    for (const statement of migration.statements) await conn.unsafe(statement)
    await record()
    await conn`commit`
  } catch (error) {
    await conn`rollback`
    throw error
  }
}

// Checks first, because if not exists on a table that is there prints a notice on every start
async function createTable(conn: postgres.ReservedSql) {
  const [{ exists }] = await conn<{ exists: boolean }[]>`select to_regclass('nerla_migrations') is not null as exists`
  if (!exists) {
    await conn`create table if not exists nerla_migrations (name text primary key, hash text not null, applied_at timestamptz not null default now())`
  }
}

async function applyMigrations(conn: postgres.Sql | postgres.ReservedSql, options: Options = {}): Promise<{ applied: string[] }> {
  if (!("release" in conn)) {
    const reserved = await conn.reserve()
    try {
      return await applyMigrations(reserved, options)
    } finally {
      reserved.release()
    }
  }
  const { dir = MIGRATIONS_DIR, log = () => {} } = options
  const migrations = await readMigrations(dir)
  await createTable(conn)
  const applied = await appliedHashes(conn)
  for (const migration of migrations) {
    const hash = applied.get(migration.name)
    if (hash !== undefined && hash !== migration.hash) {
      throw new MigrationError(
        `Migration ${migration.name} was changed after it ran on this database. Put the file back as it was shipped, or restore from a backup.`,
      )
    }
  }
  const pending = migrations.filter((migration) => !applied.has(migration.name))
  for (const migration of pending) {
    log(`Applying migration ${migration.name}`)
    try {
      await apply(conn, migration)
    } catch (error) {
      const outcome = migration.transaction
        ? "Nothing from it was kept. Fix the cause and start again."
        : "It runs outside a transaction, so part of it may be in place. It is safe to start again once the cause is fixed."
      throw new MigrationError(`Migration ${migration.name} failed: ${(error as Error).message}. ${outcome}`, error)
    }
  }
  return { applied: pending.map((migration) => migration.name) }
}

// Polls, because a session waiting inside pg_advisory_lock holds a snapshot that create index concurrently waits for
async function takeLock(conn: postgres.ReservedSql, log: (line: string) => void) {
  for (let tries = 0; ; tries++) {
    const [{ locked }] = await conn<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext('nerla-migrate')) as locked`
    if (locked) return
    if (tries === 0) log("Waiting for another start to finish its migrations")
    await sleep(250)
  }
}

async function withMigrationLock<T>(
  sql: postgres.Sql,
  fn: (conn: postgres.ReservedSql) => Promise<T>,
  options: { log?: (line: string) => void } = {},
): Promise<T> {
  const conn = await sql.reserve()
  try {
    await takeLock(conn, options.log ?? (() => {}))
    try {
      return await fn(conn)
    } finally {
      await conn`select pg_advisory_unlock(hashtext('nerla-migrate'))`
    }
  } finally {
    conn.release()
  }
}

export function migrate(sql: postgres.Sql, options?: Options): Promise<{ applied: string[] }> {
  return withMigrationLock(sql, (conn) => applyMigrations(conn, options), { log: options?.log })
}

if (require.main === module) {
  loadEnvFile()
  void (async () => {
    let client: postgres.Sql | undefined
    try {
      // NAME_FILE secrets fill their variables here as they do when the server starts
      const fileProblems = resolveSecretFiles(process.env)
      if (fileProblems.length > 0) throw new Error(fileProblems.map((problem) => problem.message).join(" "))
      client = (await import("./index")).db.$client
      await migrate(client, { log: console.log })
      console.log("The database is up to date")
    } catch (error) {
      console.error(`FATAL: ${errorText(error)}`)
      process.exitCode = 1
    } finally {
      await client?.end()
    }
  })()
}
