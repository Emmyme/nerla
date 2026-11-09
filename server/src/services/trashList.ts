import { and, desc, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm"
import { calendarEvents, db, users } from "../db"
import type { Via } from "../utils/aiTypes"
import { serverInstant } from "../utils/chatAccess"
import { dayTextIn } from "../utils/eventNotice"
import { presenceName } from "../utils/presence"
import { stillInSeries } from "../utils/seriesEdit"
import { can, factsKind, type FileFacts, type ViewerFacts } from "../utils/fileAccess"
import { eventTrashRights, projectTrashRights, purgeAt, restoreBlock, taskTrashRights, type TrashKind } from "../utils/trash"
import type { FileViewer } from "./files"
import {
  ids,
  trashAfter,
  trashFiles,
  trashFolders,
  trashKeyOf,
  type TrashFileRow,
  type TrashFolderRow,
  type TrashPage,
} from "./fileQueries"
import { visibilityOf } from "./calendarQueries"
import { personZone } from "./people"

/** `uploads` is files without folders, for the AI, which never restores a folder */
type TrashFilter = "all" | "files" | "uploads" | "docs" | "tasks" | "events" | "projects"

export type TrashItem = {
  kind: TrashKind
  id: string
  name: string
  detail: string | null
  where: { kind: "project" | "folder" | "own"; name: string | null }
  /** Where Open leads for a file or folder: its project, and its parent folder while that is not in Trash */
  projectId?: string | null
  folderId?: string | null
  /** A project's tile */
  color?: string | null
  icon?: string | null
  /** The words a restore would be refused with now, or null */
  blocked: string | null
  deletedAt: string
  deletedBy: { id: string; name: string } | null
  deletedVia: Via | null
  purgeAt: string
  can: { restore: boolean; purge: boolean }
}

const TRASH_PAGE = 50

const KEY_SHAPE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** The cursor `{deletedAt}|{id}` as its two parts, or null when it is unreadable or names no real moment */
export function readTrashCursor(value: string): [string, string] | null {
  const match = KEY_SHAPE.exec(value)
  if (!match) return null
  const seconds = `${match[1].slice(0, 10)}T${match[1].slice(11, 19)}`
  const ms = Date.parse(`${seconds}Z`)
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(seconds) ? [match[1], match[2]] : null
}

type Stamp = {
  deleted_at: string
  deleted_by: string | null
  deleter_first: string | null
  deleter_last: string | null
  deleted_via: Via | null
}

const stampOf = (row: Stamp) => ({
  deletedAt: row.deleted_at,
  deletedBy: row.deleted_by ? { id: row.deleted_by, name: presenceName(row.deleter_first, row.deleter_last) } : null,
  deletedVia: row.deleted_via ?? null,
  purgeAt: purgeAt(row.deleted_at),
})

const placeOf = (projectName: string | null, folderName: string | null): TrashItem["where"] =>
  projectName !== null
    ? { kind: "project", name: projectName }
    : folderName !== null
      ? { kind: "folder", name: folderName }
      : { kind: "own", name: null }

/** The refusal a restore gives while the item's project is in Trash */
const projectBlock = (name: string | null, trashed: boolean) => restoreBlock(trashed ? { name: name ?? "", deletedAt: "trashed" } : null)

/** The file rules the restore and purge routes apply. While its project is in Trash it waits for the project */
function fileCan(row: TrashFileRow | TrashFolderRow, v: FileViewer, folder: boolean): Pick<TrashItem, "can" | "blocked"> {
  const facts: FileFacts = {
    organizationId: row.organization_id,
    ownerId: row.owner_id,
    ownerRemovedAt: "owner_removed_at" in row ? row.owner_removed_at : null,
    projectId: row.project_id,
    kind: "kind" in row ? factsKind(row.kind) : "file",
    isDraft: "is_draft" in row ? row.is_draft : false,
    deletedAt: row.deleted_at,
  }
  const viewer: ViewerFacts = { ...v, projectRole: row.project_role, seesALink: false, hasGrant: false }
  // A project folder holds other users' files, so only a project admin acts on one
  const could = !folder || !row.project_id || row.project_role === "admin"
  const allowed = could && !row.project_trashed
  return {
    can: { restore: allowed && can("restore", facts, viewer), purge: allowed && can("purge", facts, viewer) },
    blocked: could && can("restore", facts, viewer) ? projectBlock(row.project_name, row.project_trashed) : null,
  }
}

async function fileItems(v: FileViewer, of: "all" | "files" | "docs", page: TrashPage): Promise<TrashItem[]> {
  const rows = await trashFiles(v, of, page)
  return rows.map((row) => ({
    kind: row.doc_type === "paper" ? "paper" : row.doc_type === "board" ? "board" : "file",
    id: row.id,
    name: row.name,
    detail: null,
    where: placeOf(row.project_name, row.folder_name),
    projectId: row.project_id,
    folderId: row.folder_id,
    ...stampOf(row),
    ...fileCan(row, v, false),
  }))
}

async function folderItems(v: FileViewer, page: TrashPage): Promise<TrashItem[]> {
  const rows = await trashFolders(v, page)
  return rows.map((row) => ({
    kind: "folder",
    id: row.id,
    name: row.name,
    detail: null,
    where: placeOf(row.project_name, row.folder_name),
    projectId: row.project_id,
    folderId: row.folder_id,
    ...stampOf(row),
    ...fileCan(row, v, true),
  }))
}

type TaskRow = Stamp & {
  id: string
  title: string
  project_id: string | null
  project_name: string | null
  project_trashed: boolean
  assigned_to: string | null
  project_role: "admin" | "member" | null
}

/** Tasks trashed on their own: a personal one to its assignee, a project's to its members, the project in Trash or not */
async function taskItems(v: FileViewer, page: TrashPage): Promise<TrashItem[]> {
  const { V, O } = ids(v)
  // trash: the Trash list reads tasks in Trash, and their projects whether or not those are in Trash too
  const rows = await db.execute<TaskRow>(sql`
    select t.id, t.title, t.project_id, p.name as project_name, p.deleted_at is not null as project_trashed,
      t.assigned_to, pm.role as project_role, ${trashKeyOf(sql`t.deleted_at`)} as deleted_at, t.deleted_by,
      du.first_name as deleter_first, du.last_name as deleter_last, t.deleted_via
    from tasks t
    left join projects p on p.id = t.project_id and p.organization_id = ${O}
    left join lateral (
      select case when bool_or(m.role = 'admin') then 'admin' else 'member' end as role
      from project_members m where m.project_id = t.project_id and m.user_id = ${V}
      having count(*) > 0) pm on true
    left join users du on du.id = t.deleted_by
    where t.organization_id = ${O} and t.deleted_at is not null and t.trash_root is null
      and ((t.project_id is null and t.assigned_to = ${V}) or (p.id is not null and pm.role is not null))
      ${trashAfter(page, sql`t.deleted_at`, sql`t.id`)}
    order by t.deleted_at desc, t.id desc
    limit ${page.limit}::int`)
  return rows.map((row) => {
    const rights = taskTrashRights(
      { projectId: row.project_id, assignedTo: row.assigned_to, deletedBy: row.deleted_by },
      { userId: v.userId, projectRole: row.project_role },
    )
    return {
      kind: "task",
      id: row.id,
      name: row.title,
      detail: null,
      where: placeOf(row.project_name, null),
      ...stampOf(row),
      can: { restore: rights.restore && !row.project_trashed, purge: rights.purge },
      blocked: rights.restore ? projectBlock(row.project_name, row.project_trashed) : null,
    }
  })
}

type EventRow = typeof calendarEvents.$inferSelect

const dayOf = (stored: string | null, zone: string, allDay: boolean) =>
  stored ? dayTextIn(new Date(serverInstant(stored)).toISOString(), zone, allDay) : ""

/** Which of the four Trash entries an event row is. A "This and following" tail was made by the same change that trashed it */
function eventDetail(entry: EventRow, zone: string): string {
  if (entry.seriesId) return `One occurrence on ${dayOf(entry.originalStart ?? entry.startsAt, zone, entry.allDay)}`
  if (entry.recurrenceRule && entry.createdAt === entry.deletedAt) return `From ${dayOf(entry.startsAt, zone, entry.allDay)} on`
  if (entry.recurrenceRule) return "Every occurrence"
  return dayOf(entry.startsAt, zone, entry.allDay)
}

/** Event entries to their organiser, and to the workspace admin who deleted them */
async function eventItems(v: FileViewer, page: TrashPage): Promise<TrashItem[]> {
  const before = page.before
    ? sql`(${calendarEvents.deletedAt}, ${calendarEvents.id}) < (${page.before[0]}::timestamp, ${page.before[1]}::uuid)`
    : undefined
  // trash: the Trash list reads event entries in Trash
  const rows = await db
    .select({
      event: calendarEvents,
      key: sql<string>`${trashKeyOf(sql`${calendarEvents.deletedAt}`)}`,
      deleterFirst: users.firstName,
      deleterLast: users.lastName,
    })
    .from(calendarEvents)
    .leftJoin(users, eq(users.id, calendarEvents.deletedBy))
    .where(
      and(
        eq(calendarEvents.organizationId, v.organizationId),
        isNotNull(calendarEvents.deletedAt),
        eq(calendarEvents.trashRoot, calendarEvents.id),
        v.isOrgAdmin
          ? or(eq(calendarEvents.createdBy, v.userId), eq(calendarEvents.deletedBy, v.userId))
          : eq(calendarEvents.createdBy, v.userId),
        before,
      ),
    )
    .orderBy(desc(calendarEvents.deletedAt), desc(calendarEvents.id))
    .limit(page.limit)
  if (rows.length === 0) return []
  const seriesIds = [...new Set(rows.flatMap((row) => (row.event.seriesId ? [row.event.seriesId] : [])))]
  // trash: an occurrence's series, live or in Trash, decides whether the occurrence can come back
  const masters = seriesIds.length
    ? await db
        .select()
        .from(calendarEvents)
        .where(and(inArray(calendarEvents.id, seriesIds), eq(calendarEvents.organizationId, v.organizationId)))
    : []
  const seriesById = new Map(masters.map((row) => [row.id, row]))
  const zone = await personZone(v.userId)
  // An admin may delete an event they can't see in full, and Trash never shows them more than the calendar did
  const hidden = new Set<string>()
  for (const { event } of rows) {
    if (event.createdBy !== v.userId && (await visibilityOf({ id: v.userId, organizationId: v.organizationId }, event)) !== "full") {
      hidden.add(event.id)
    }
  }
  return rows.map(({ event, key, deleterFirst, deleterLast }) => {
    const rights = eventTrashRights(event, { userId: v.userId, isOrgAdmin: v.isOrgAdmin })
    const series = event.seriesId ? seriesById.get(event.seriesId) : undefined
    // The words the restore route refuses with, in its order
    const blocked = !series
      ? null
      : series.deletedAt
        ? "Restore the series first"
        : stillInSeries(series, event)
          ? null
          : "This occurrence is no longer part of the series"
    return {
      kind: "event",
      id: event.id,
      name: hidden.has(event.id) ? "A private event" : event.title,
      detail: hidden.has(event.id) ? null : eventDetail(event, zone),
      where: { kind: "own", name: null },
      ...stampOf({
        deleted_at: key,
        deleted_by: event.deletedBy,
        deleter_first: deleterFirst,
        deleter_last: deleterLast,
        deleted_via: event.deletedVia,
      }),
      can: { restore: rights.restore && !blocked, purge: rights.purge },
      blocked: rights.restore ? blocked : null,
    }
  })
}

type ProjectRow = Stamp & {
  id: string
  name: string
  color: string | null
  icon: string | null
  task_count: number
  file_count: number
  paper_count: number
  board_count: number
  admin: boolean
}

/** "With 2 tasks, 3 files and 1 board", zeros left out, and null when it held nothing */
function heldLine(counts: [number, string, string][]): string | null {
  const parts = counts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
  if (parts.length === 0) return null
  return `With ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}`
}

/** Projects in Trash to their admins and every workspace admin, with what went with them */
async function projectItems(v: FileViewer, page: TrashPage): Promise<TrashItem[]> {
  const { V, O } = ids(v)
  const reach: SQL = v.isOrgAdmin
    ? sql`true`
    : sql`exists (select 1 from project_members m where m.project_id = p.id and m.user_id = ${V} and m.role = 'admin')`
  // trash: the Trash list reads projects in Trash and counts the tasks and files that went with them
  const rows = await db.execute<ProjectRow>(sql`
    select p.id, p.name, p.color, p.icon, ${trashKeyOf(sql`p.deleted_at`)} as deleted_at, p.deleted_by,
      du.first_name as deleter_first, du.last_name as deleter_last, p.deleted_via,
      exists (select 1 from project_members m where m.project_id = p.id and m.user_id = ${V} and m.role = 'admin') as admin,
      (select count(*) from tasks t where t.project_id = p.id and t.trash_root = p.id)::int as task_count,
      (select count(*) from file_attachments f where f.project_id = p.id and f.trash_root = p.id and f.kind = 'file'
        and f.doc_type is null and f.organization_id = ${O})::int as file_count,
      (select count(*) from file_attachments f where f.project_id = p.id and f.trash_root = p.id and f.kind = 'file'
        and f.doc_type = 'paper' and f.organization_id = ${O})::int as paper_count,
      (select count(*) from file_attachments f where f.project_id = p.id and f.trash_root = p.id and f.kind = 'file'
        and f.doc_type = 'board' and f.organization_id = ${O})::int as board_count
    from projects p
    left join users du on du.id = p.deleted_by
    where p.organization_id = ${O} and p.deleted_at is not null and ${reach}
      ${trashAfter(page, sql`p.deleted_at`, sql`p.id`)}
    order by p.deleted_at desc, p.id desc
    limit ${page.limit}::int`)
  return rows.map((row) => {
    const rights = projectTrashRights({ projectRole: row.admin ? "admin" : null, isOrgAdmin: v.isOrgAdmin })
    return {
      kind: "project",
      id: row.id,
      name: row.name,
      detail: heldLine([
        [row.task_count, "task", "tasks"],
        [row.file_count, "file", "files"],
        [row.paper_count, "paper", "papers"],
        [row.board_count, "board", "boards"],
      ]),
      where: { kind: "own", name: null },
      color: row.color,
      icon: row.icon,
      ...stampOf(row),
      can: { restore: rights.restore, purge: rights.purge },
      blocked: null,
    }
  })
}

const SOURCES: Record<TrashFilter, ((v: FileViewer, page: TrashPage) => Promise<TrashItem[]>)[]> = {
  all: [(v, page) => fileItems(v, "all", page), folderItems, taskItems, eventItems, projectItems],
  files: [(v, page) => fileItems(v, "files", page), folderItems],
  uploads: [(v, page) => fileItems(v, "files", page)],
  docs: [(v, page) => fileItems(v, "docs", page)],
  tasks: [taskItems],
  events: [eventItems],
  projects: [projectItems],
}

const newestFirst = (a: TrashItem, b: TrashItem) =>
  a.deletedAt === b.deletedAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.deletedAt < b.deletedAt ? 1 : -1

/**
 * One page of what the viewer could restore or delete for good, of every kind or one filter's, newest deleted first.
 * Each source is asked for a page past the cursor from `readTrashCursor`, then the pages are merged and cut. What went
 * with a project shows only as the project's entry
 */
export async function listTrash(
  viewer: FileViewer,
  filter: TrashFilter,
  before: [string, string] | null,
): Promise<{ items: TrashItem[]; nextCursor: string | null }> {
  const page: TrashPage = { before, limit: TRASH_PAGE + 1 }
  const found = (await Promise.all(SOURCES[filter].map((source) => source(viewer, page)))).flat().sort(newestFirst)
  const items = found.slice(0, TRASH_PAGE)
  const last = items[items.length - 1]
  return { items, nextCursor: found.length > TRASH_PAGE && last ? `${last.deletedAt}|${last.id}` : null }
}
