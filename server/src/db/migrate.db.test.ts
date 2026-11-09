import { randomBytes } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres from "postgres"
import { afterAll, afterEach, describe, expect, inject, it } from "vitest"
import { databaseUrl } from "../test/dbGlobalSetup"
import { migrate, MIGRATIONS_DIR, MigrationError, pendingMigrations } from "./migrate"

const base = inject("testDatabaseUrl")
const admin = postgres(base, { max: 1, connect_timeout: 3, onnotice: () => {}, connection: { TimeZone: "UTC" } })
const databases: string[] = []
const clients: postgres.Sql[] = []
const dirs: string[] = []

async function emptyDatabase(): Promise<string> {
  const name = `nerla_test_${process.env.VITEST_POOL_ID}_${Math.floor(Date.now() / 1000)}_${randomBytes(4).toString("hex")}`
  await admin`create database ${admin(name)}`
  databases.push(name)
  return databaseUrl(base, name)
}

function client(url: string): postgres.Sql {
  const sql = postgres(url, { onnotice: () => {}, connection: { TimeZone: "UTC" } })
  clients.push(sql)
  return sql
}

// A copy of the shipped migrations plus extra files, each added to the journal
function migrationsWith(extra: Record<string, string>, { baseline = true } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "nerla-migrations-"))
  dirs.push(dir)
  if (baseline) cpSync(MIGRATIONS_DIR, dir, { recursive: true })
  else mkdirSync(join(dir, "meta"))
  const journalPath = join(dir, "meta", "_journal.json")
  const entries: { tag: string }[] = baseline ? JSON.parse(readFileSync(journalPath, "utf8")).entries : []
  for (const [tag, body] of Object.entries(extra)) {
    entries.push({ tag })
    writeFileSync(join(dir, `${tag}.sql`), body)
  }
  writeFileSync(journalPath, JSON.stringify({ entries }))
  return dir
}

const SHIPPED = (
  JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] }
).entries.map((entry) => entry.tag)

const appliedNames = async (sql: postgres.Sql) =>
  (await sql<{ name: string }[]>`select name from nerla_migrations order by name`).map((r) => r.name)

afterEach(async () => {
  await Promise.all(clients.splice(0).map((sql) => sql.end({ timeout: 5 })))
  for (const name of databases.splice(0)) await admin`drop database if exists ${admin(name)} with (force)`
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

afterAll(() => admin.end())

describe("the migration runner", () => {
  // The two that apply the real baseline get the time it takes under load
  it("a fresh database gets every migration once", { timeout: 60_000 }, async () => {
    const sql = client(await emptyDatabase())
    expect(await pendingMigrations(sql)).toEqual(SHIPPED)
    expect(await migrate(sql)).toEqual({ applied: SHIPPED })
    expect(await appliedNames(sql)).toEqual(SHIPPED)
    expect(await pendingMigrations(sql)).toEqual([])
    expect(await migrate(sql)).toEqual({ applied: [] })
  })

  it("two starts at once apply each migration once", { timeout: 60_000 }, async () => {
    const url = await emptyDatabase()
    const results = await Promise.all([migrate(client(url)), migrate(client(url))])
    expect(results.flatMap((r) => r.applied)).toEqual(SHIPPED)
    expect(await appliedNames(client(url))).toEqual(SHIPPED)
  })

  it("two starts at once, with a concurrent index build", async () => {
    const url = await emptyDatabase()
    const dir = migrationsWith(
      {
        "0000_widgets": "create table widgets (id int);",
        // Keeps the first start busy long enough for the second to be waiting
        "0001_sleep": "select pg_sleep(1.5);",
        "0002_index": [
          "-- nerla:no-transaction",
          "drop index concurrently if exists widgets_id_idx;",
          "--> statement-breakpoint",
          "create index concurrently widgets_id_idx on widgets (id);",
        ].join("\n"),
      },
      { baseline: false },
    )
    await Promise.all([migrate(client(url), { dir }), migrate(client(url), { dir })])
    const sql = client(url)
    expect(await appliedNames(sql)).toEqual(["0000_widgets", "0001_sleep", "0002_index"])
    const [{ valid }] = await sql<
      { valid: boolean }[]
    >`select indisvalid as valid from pg_index where indexrelid = 'widgets_id_idx'::regclass`
    expect(valid).toBe(true)
  })

  it("an edited migration stops the start", async () => {
    const sql = client(await emptyDatabase())
    const dir = migrationsWith({ "0000_widgets": "create table widgets (id int);" }, { baseline: false })
    await migrate(sql, { dir })
    writeFileSync(join(dir, "0000_widgets.sql"), "create table widgets (id int) ;")
    const run = migrate(sql, { dir })
    await expect(run).rejects.toThrow(MigrationError)
    await expect(run).rejects.toThrow(/0000_widgets was changed after it ran/)
  })

  it("a migration that fails leaves nothing half done", async () => {
    const sql = client(await emptyDatabase())
    const dir = migrationsWith(
      {
        "0000_widgets": "create table widgets (id int);",
        "0001_bad": "create table half_done (id int);\n--> statement-breakpoint\nselect * from no_such_table;\n",
      },
      { baseline: false },
    )
    await expect(migrate(sql, { dir })).rejects.toThrow(MigrationError)
    const [{ table }] = await sql<{ table: string | null }[]>`select to_regclass('half_done')::text as table`
    expect(table).toBeNull()
    expect(await appliedNames(sql)).toEqual(["0000_widgets"])
  })

  it("a no-transaction migration can build an index concurrently", async () => {
    const sql = client(await emptyDatabase())
    const body = [
      "-- nerla:no-transaction",
      "create table if not exists widgets (id int);",
      "--> statement-breakpoint",
      "create index concurrently if not exists widgets_id_idx on widgets (id);",
    ].join("\n")
    const dir = migrationsWith({ "0000_concurrent": body }, { baseline: false })
    expect(await migrate(sql, { dir })).toEqual({ applied: ["0000_concurrent"] })
    const [{ index }] = await sql<{ index: string | null }[]>`select to_regclass('widgets_id_idx')::text as index`
    expect(index).toBe("widgets_id_idx")
  })
})
