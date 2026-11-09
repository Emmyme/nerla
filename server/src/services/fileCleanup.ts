import { sql, type SQL } from "drizzle-orm"
import { db } from "../db"
import { REMOVAL_DAYS } from "../utils/fileAccess"
import { AVATAR_DAYS, DRAFT_DAYS, isStaleAvatar, LINK_KEEP_DAYS, shouldPurge, TRASH_DAYS } from "../utils/fileLinks"
import { logger } from "../utils/logger"
import { purgeFile, type PurgeGuard } from "./files"
import { purgeDueEvents, purgeDueProjects, purgeDueTasks, type PurgeTally } from "./trashCleanup"
import { errorText } from "../utils/errorText"

const BATCH = 200

type CleanupResult = {
  purged: number
  failed: number
  folders: number
  links: number
  projects: number
  tasks: number
  events: number
  skipped: boolean
  /** Steps that stopped on an error. The counts still hold what they did before it */
  failedSteps: string[]
}

type Candidate = {
  id: string
  kind: string
  deleted_at: string | null
  is_draft: boolean
  created_at: string
  project_id: string | null
  owner_removed_at: string | null
  owner_rejoin_until: string | null
  referenced: boolean
}

const before = (now: Date, days: number) =>
  sql`((${now.toISOString()}::timestamptz at time zone 'utc') - make_interval(days => ${days}::int))`

/** A user's current avatar, the AI's, a group's picture, or posted somewhere */
const referenced = sql`(exists (select 1 from users au where au.avatar_file_id = f.id)
  or exists (select 1 from users au where au.avatar_url = '/users/avatar/' || f.id::text)
  or exists (select 1 from ai_settings s where s.avatar_file_id = f.id)
  or exists (select 1 from group_chats g where g.avatar_file_id = f.id)
  or exists (select 1 from file_links l where l.file_id = f.id))`

// trash: what went with a project goes only with the project's own purge, so a failed one still restores whole
const notWithProject = (trashRoot: SQL) => sql`not exists (select 1 from projects p where p.id = ${trashRoot})`

/** Rows that may be due, after `after` in id order. `shouldPurge` and `isStaleAvatar` decide each one */
async function candidates(now: Date, after: string | null): Promise<Candidate[]> {
  // tenancy: the job works across every workspace on purpose
  const rows = await db.execute<Candidate>(sql`
    select f.id, f.kind, f.deleted_at::text as deleted_at, f.is_draft, f.created_at::text as created_at, f.project_id,
      u.removed_at::text as owner_removed_at, u.rejoin_invited_until::text as owner_rejoin_until, ${referenced} as referenced
    from file_attachments f join users u on u.id = f.uploaded_by
    where (${after}::uuid is null or f.id > ${after}::uuid)
      and (
        (f.kind = 'avatar' and f.created_at <= ${before(now, AVATAR_DAYS)} and not ${referenced})
        or (f.kind <> 'avatar' and (
          (f.deleted_at is not null and f.deleted_at <= ${before(now, TRASH_DAYS)} and ${notWithProject(sql`f.trash_root`)})
          or (f.is_draft and f.created_at <= ${before(now, DRAFT_DAYS)})
          or (f.project_id is null and u.removed_at is not null and u.removed_at <= ${before(now, REMOVAL_DAYS)}))))
    order by f.id
    limit ${BATCH}::int`)
  return [...rows]
}

/** Avatars go only when nobody uses them, so a removed user's picture stays on what they wrote */
function isDue(row: Candidate, now: Date): boolean {
  if (row.kind === "avatar") return isStaleAvatar({ createdAt: row.created_at, referenced: row.referenced }, now)
  return shouldPurge(
    {
      deletedAt: row.deleted_at,
      isDraft: row.is_draft,
      createdAt: row.created_at,
      projectId: row.project_id,
      ownerRemovedAt: row.owner_removed_at,
      ownerRejoinUntil: row.owner_rejoin_until,
    },
    now,
  )
}

/**
 * The rule that made the row due, checked again by the delete itself, so a file restored, posted, put back as an
 * avatar, or whose owner rejoined since the row was read survives
 */
function guardFor(row: Candidate, now: Date): PurgeGuard {
  if (row.kind === "avatar") {
    return { expect: "any", condition: sql`f.kind = 'avatar' and f.created_at <= ${before(now, AVATAR_DAYS)} and not ${referenced}` }
  }
  // Due by whichever rule comes first, each checked in full, so one rule never delays another
  const trash = sql`(f.deleted_at is not null and f.deleted_at <= ${before(now, TRASH_DAYS)} and ${notWithProject(sql`f.trash_root`)})`
  const draft = sql`(f.is_draft and f.deleted_at is null and f.created_at <= ${before(now, DRAFT_DAYS)})`
  const removal = sql`(f.project_id is null and exists (
    select 1 from users u where u.id = f.uploaded_by and u.removed_at is not null
      and u.removed_at <= ${before(now, REMOVAL_DAYS)}
      and (u.rejoin_invited_until is null or u.rejoin_invited_until <= (${now.toISOString()}::timestamptz at time zone 'utc'))))`
  return { expect: "any", condition: sql`f.kind <> 'avatar' and (${trash} or ${draft} or ${removal})` }
}

/** Each file stands alone, so one failure leaves the rest to go on and is tried again on the next run */
async function purgeDueFiles(now: Date, result: CleanupResult): Promise<void> {
  let after: string | null = null
  for (;;) {
    const rows = await candidates(now, after)
    for (const row of rows) {
      if (!isDue(row, now)) continue
      try {
        if (await purgeFile(row.id, guardFor(row, now))) result.purged++
      } catch (error) {
        result.failed++
        logger.warn("File cleanup could not purge a file", {
          fileId: row.id,
          error: errorText(error),
        })
      }
    }
    if (rows.length < BATCH) return
    after = rows[rows.length - 1].id
  }
}

/** Trashed folders past their 30 days whose files are all gone */
async function deleteEmptyTrashedFolders(now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    // tenancy: the job works across every workspace on purpose
    const gone = await tx.execute<{ id: string }>(sql`
      delete from file_folders ff
      where ff.deleted_at is not null and ff.deleted_at <= ${before(now, TRASH_DAYS)}
        and not exists (select 1 from file_attachments f where f.folder_id = ff.id)
        and not exists (select 1 from file_attachments f where ff.trash_root is not null and f.trash_root = ff.trash_root)
        and ${notWithProject(sql`ff.trash_root`)}
      returning ff.id`)
    const ids = gone.map((row) => row.id)
    if (ids.length > 0) {
      const list = sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )
      // tenancy: only the folders that pointed at a folder just deleted
      await tx.execute(sql`update file_folders set parent_folder_id = null where parent_folder_id in (${list})`)
    }
    return ids.length
  })
}

async function deleteOldLinks(now: Date): Promise<number> {
  // tenancy: the job works across every workspace on purpose
  const gone = await db.execute(sql`
    delete from file_share_links
    where (revoked_at is not null and revoked_at <= ${before(now, LINK_KEEP_DAYS)})
      or (expires_at is not null and expires_at <= ${before(now, LINK_KEEP_DAYS)})`)
  return gone.count
}

/**
 * Purges what is due: projects, tasks and events in Trash past 30 days, projects first since their tasks and files go
 * with them. Then files in Trash past 30 days, drafts past a day, unused avatars past a day, and a removed member's own
 * files past their 30 days unless a rejoin is pending. Then empty trashed folders and long dead links go. Only one
 * run works at a time and another skips, since a run late in its slot can still be working when the next slot starts,
 * and two would purge the same projects and files at once
 */
async function runFileCleanup(now: Date = new Date()): Promise<CleanupResult> {
  // The lock lives as long as this transaction, while the work commits row by row on other connections
  return db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext('file-cleanup')) as locked`)
    const result: CleanupResult = {
      purged: 0,
      failed: 0,
      folders: 0,
      links: 0,
      projects: 0,
      tasks: 0,
      events: 0,
      skipped: !lock?.locked,
      failedSteps: [],
    }
    if (result.skipped) return result
    const tally = (key: "projects" | "tasks" | "events", run: (now: Date) => Promise<PurgeTally>) => async () => {
      const done = await run(now)
      result[key] = done.purged
      result.failed += done.failed
    }
    await step("projects", result, tally("projects", purgeDueProjects))
    await step("tasks", result, tally("tasks", purgeDueTasks))
    await step("events", result, tally("events", purgeDueEvents))
    await step("files", result, () => purgeDueFiles(now, result))
    await step("folders", result, async () => {
      result.folders = await deleteEmptyTrashedFolders(now)
    })
    await step("links", result, async () => {
      result.links = await deleteOldLinks(now)
    })
    return result
  })
}

/** One step's failure is logged and leaves the next steps to run */
async function step(name: string, result: CleanupResult, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    result.failedSteps.push(name)
    logger.warn("File cleanup step failed", { step: name, error: errorText(error) })
  }
}

/** The daily file-cleanup job. A step that stopped on an error fails the job, so the setup check shows it */
export async function fileCleanupJob(): Promise<void> {
  const result = await runFileCleanup()
  if (result.skipped) {
    logger.info("File cleanup skipped, since another run is still working")
    return
  }
  logger.info("File cleanup finished", result)
  if (result.failedSteps.length > 0) {
    throw new Error(`File cleanup could not finish these steps: ${result.failedSteps.join(", ")}. The server log says why.`)
  }
}
