import { db } from "../../src/db"
import { checkStorage } from "../../src/services/storage"
import { refuseExistingUsers, refuseStorage, type SeedOptions } from "./guard"
import { seedShowcase, type ShowcaseIds } from "./showcase"
import { seedNerla, seedOther, type NerlaIds, type OtherIds } from "./workspaces"

/** Every table the seed writes, itself or through the services it calls */
export const SEED_TABLES = [
  "organizations",
  "users",
  "organization_members",
  "projects",
  "project_members",
  "group_chats",
  "group_chat_members",
  "tasks",
  "task_comments",
  "task_activity",
  "messages",
  "file_attachments",
  "file_links",
  "file_grants",
  "doc_contents",
  "calendar_events",
  "event_attendees",
  "time_entries",
] as const

/** The showcase also writes these. Emptying the seeded tables empties them too, as they point at users */
const SHOWCASE_TABLES = [...SEED_TABLES, "message_reactions", "group_chat_reads", "notifications"] as const

export type SeedSummary = {
  database: string
  counts: Record<(typeof SEED_TABLES)[number], number>
  nerla: NerlaIds
  other: OtherIds
}

export type ShowcaseSummary = {
  database: string
  counts: Record<(typeof SHOWCASE_TABLES)[number], number>
  showcase: ShowcaseIds
}

const client = () => db.$client

export async function runSeed(options: SeedOptions): Promise<SeedSummary> {
  const database = await prepare(options, options.storage)
  const nerla = await seedNerla(options.storage)
  const other = await seedOther()
  return { database, counts: await countRows(SEED_TABLES), nerla, other }
}

/** The showcase workspace alone. It stores no file, so the file storage is never checked */
export async function runShowcase(options: SeedOptions): Promise<ShowcaseSummary> {
  const database = await prepare(options, false)
  const showcase = await seedShowcase()
  return { database, counts: await countRows(SHOWCASE_TABLES), showcase }
}

async function prepare(options: SeedOptions, storage: boolean): Promise<string> {
  const sql = client()
  const [{ database, users }] = await sql<{ database: string; users: number }[]>`
    select current_database() as database, (select count(*) from users)::int as users`
  refuseExistingUsers(database, users, options)

  if (storage) {
    const reached = await checkStorage()
    if (!reached.ok) refuseStorage(reached.error)
  }

  if (options.reset) {
    // One transaction. CASCADE also empties the rows that point at these tables, which would be left dangling
    await sql.begin(async (transaction) => {
      // The postgres types drop the call signature from a transaction, which still runs queries the same way
      const tx = transaction as unknown as typeof sql
      // Postgres names every table the cascade reaches, which is noise here
      await tx`set local client_min_messages = warning`
      await tx`truncate table ${tx([...SEED_TABLES])} cascade`
    })
  }

  return database
}

async function countRows<T extends string>(tables: readonly T[]): Promise<Record<T, number>> {
  const sql = client()
  const counts = {} as Record<T, number>
  for (const table of tables) {
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from ${sql(table as string)}`
    counts[table] = count
  }
  return counts
}

export const closeDb = () => client().end({ timeout: 5 })
