import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

function getConnectionString(): string {
  const url = process.env.DATABASE_URL?.trim()
  if (url) return url

  const { DB_USER, DB_PASSWORD, DB_NAME, DB_HOST, DB_PORT } = process.env
  if (!DB_USER?.trim() || !DB_PASSWORD?.trim() || !DB_NAME?.trim()) {
    throw new Error("Database configuration missing: set DATABASE_URL or DB_USER, DB_PASSWORD, and DB_NAME")
  }
  return `postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST || "localhost"}:${DB_PORT || "5432"}/${DB_NAME}`
}

const connectionString = getConnectionString()

/** When unset or any value except `false`, require TLS. Set `DB_SSL=false` for local Postgres without TLS. */
const useSsl = process.env.DB_SSL !== "false"

const queryClient = postgres(connectionString, {
  ssl: useSsl ? "require" : false,
  // defaultNow() writes the session's local time, which the code reads as UTC
  connection: { TimeZone: "UTC" },
})
export const db = drizzle(queryClient, { schema })

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** The database or an open transaction, for helpers that run in either */
export type Executor = typeof db | Tx

export * from "./schema"
