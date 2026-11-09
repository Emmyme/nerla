import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseEnv } from "node:util"
import postgres from "postgres"
import type { TestProject } from "vitest/node"
import { migrate } from "../db/migrate"
import { errorText } from "../utils/errorText"

declare module "vitest" {
  export interface ProvidedContext {
    testDatabaseUrl: string
    /** Set when the template could not be built. Every db test file fails with it */
    testDatabaseError: { message: string; reason: string } | null
  }
}

export const TEMPLATE = "nerla_test_template"
export const NO_POSTGRES = "Start Postgres (docker compose up -d postgres) or set TEST_DATABASE_URL"
const LOGIN_REFUSED =
  "Postgres answered but refused the login. Set TEST_DATABASE_URL, or DB_USER and DB_PASSWORD in the root .env, to a user that can create databases, such as postgresql://<user>:<password>@localhost:5432/postgres"
// Wrong password, unknown role, missing database
const LOGIN_CODES = new Set(["28P01", "28000", "3D000"])
const MAX_AGE_SECONDS = 60 * 60
const serverDir = resolve(__dirname, "../..")

// Locally the nerla user from the root .env, the one setup creates. CI sets TEST_DATABASE_URL to its own server
function defaultBase(): string {
  const file = resolve(serverDir, "../.env")
  const env = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {}
  if (!env.DB_USER || !env.DB_PASSWORD) return "postgresql://postgres:postgres@localhost:5432/postgres"
  const url = new URL("postgresql://localhost/postgres")
  url.username = env.DB_USER
  url.password = env.DB_PASSWORD
  url.port = env.DB_PORT || "5432"
  return url.toString()
}

export function databaseUrl(base: string, name: string): string {
  const url = new URL(base)
  url.pathname = `/${name}`
  return url.toString()
}

function admin(base: string) {
  return postgres(base, { max: 1, connect_timeout: 3, onnotice: () => {}, connection: { TimeZone: "UTC" } })
}

// Postgres keeps no creation time for a database, so each test database carries its epoch seconds in its name
async function dropStale(sql: postgres.Sql) {
  const rows = await sql<{ datname: string }[]>`select datname from pg_database where starts_with(datname, 'nerla_test_')`
  const cutoff = Date.now() / 1000 - MAX_AGE_SECONDS
  for (const { datname } of rows) {
    const stamp = /^nerla_test_\d+_(\d+)_[0-9a-f]+$/.exec(datname)?.[1]
    if (stamp && Number(stamp) < cutoff) await sql`drop database if exists ${sql(datname)} with (force)`
  }
}

// A refused localhost connection is an AggregateError with one error per address
function reasonOf(error: unknown): string {
  const inner = (error as { errors?: unknown[] }).errors
  if (inner?.length) return inner.map(reasonOf).join(", ")
  return errorText(error)
}

async function buildTemplate(base: string) {
  const sql = admin(base)
  try {
    await sql`select 1`
  } catch (error) {
    await sql.end({ timeout: 0 })
    const refused = LOGIN_CODES.has((error as { code?: string }).code ?? "")
    throw Object.assign(new Error(refused ? LOGIN_REFUSED : NO_POSTGRES), { reason: reasonOf(error) })
  }
  try {
    await dropStale(sql)
    await sql`drop database if exists ${sql(TEMPLATE)} with (force)`
    await sql`create database ${sql(TEMPLATE)}`
  } finally {
    await sql.end()
  }
  const template = postgres(databaseUrl(base, TEMPLATE), { max: 1, onnotice: () => {}, connection: { TimeZone: "UTC" } })
  try {
    await migrate(template)
  } finally {
    // Cloning fails while anything is connected to the template, so this connection ends first
    await template.end()
  }
}

export default async function setup(project: TestProject) {
  const base = process.env.TEST_DATABASE_URL?.trim() || defaultBase()
  project.provide("testDatabaseUrl", base)
  try {
    await buildTemplate(base)
    project.provide("testDatabaseError", null)
  } catch (error) {
    const { message, reason } = error as Error & { reason?: string }
    project.provide(
      "testDatabaseError",
      reason ? { message, reason } : { message: "The test database template could not be built", reason: message },
    )
    return
  }
  return async () => {
    const sql = admin(base)
    await sql`drop database if exists ${sql(TEMPLATE)} with (force)`
    await sql.end()
  }
}
