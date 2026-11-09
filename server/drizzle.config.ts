import { defineConfig } from "drizzle-kit"

// No .env is fine, the variables can come from the environment
try {
  process.loadEnvFile()
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
}

/** When unset or any value except `false`, require TLS. Set `DB_SSL=false` for local Postgres without TLS. */
const ssl = process.env.DB_SSL !== "false"

function getDbCredentials():
  | { url: string }
  | {
      host: string
      port: number
      user: string
      password: string
      database: string
      ssl: boolean
    } {
  const url = process.env.DATABASE_URL?.trim()
  if (url) {
    return { url }
  }

  const { DB_USER, DB_PASSWORD, DB_NAME, DB_HOST, DB_PORT } = process.env
  if (!DB_USER?.trim() || !DB_PASSWORD?.trim() || !DB_NAME?.trim()) {
    throw new Error("Database configuration missing for drizzle-kit: set DATABASE_URL or DB_USER, DB_PASSWORD, and DB_NAME")
  }

  return {
    host: DB_HOST || "localhost",
    port: parseInt(DB_PORT || "5432", 10),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    ssl,
  }
}

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: getDbCredentials(),
})
