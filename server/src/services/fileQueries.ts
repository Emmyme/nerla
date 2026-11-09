import { and, eq, isNull, sql, type SQL } from "drizzle-orm"
import { db, fileFolders, users, type Executor, type Tx } from "../db"
import type { Via } from "../utils/aiTypes"
import type { DocType } from "../utils/docAccess"
import { can, factsKind, removalDeadline, REMOVAL_DAYS, type FileAction, type FileFacts, type ViewerFacts } from "../utils/fileAccess"
import { presenceName } from "../utils/presence"
import { LIVE_PROJECT_SQL, LIVE_TASK_SQL } from "../utils/trash"
import { uploadCeiling, type Caps } from "../utils/storageCaps"
import type { FolderColor } from "../validation/schemas"
import type { SymbolKey } from "../utils/symbols"
import { MAX_FOLDER_DEPTH, type FileRow, type FileViewer, type FolderRow } from "./files"
import { ADMIN_VIEWER, projectReadAccess } from "./projectAccess"

const PAGE_SIZE = 100
const RECENT_LIMIT = 50
export const SEARCH_LIMIT = 50
const FOLDER_LIMIT = 1000
const OPAQUE = "application/octet-stream"

const FILE_ACTIONS: FileAction[] = ["view", "rename", "move", "trash", "restore", "purge", "share", "link", "copy", "attach", "editAlt"]
const FOLDER_ACTIONS: FileAction[] = ["view", "rename", "move", "trash", "restore", "purge", "share", "link"]

export type FileKind = "image" | "pdf" | "video" | "audio" | "file"
export type FileContext = { by: string; where: string; href: string }
export type FileDto = {
  id: string
  name: string
  size: number
  mimeType: string
  kind: FileKind
  /** Set for a paper or board, which opens in its editor */
  docType: DocType | null
  altText: string | null
  owner: { id: string; name: string; avatarUrl: string | null }
  projectId: string | null
  folderId: string | null
  updatedAt: string
  deletedAt: string | null
  removalDeadline: string | null
  context: FileContext | null
  can: FileAction[]
  /** Set when the owner's AI or agent created it */
  done_via: Via | null
}
type FolderDto = {
  id: string
  name: string
  color: FolderColor | null
  icon: SymbolKey | null
  parentId: string | null
  projectId: string | null
  updatedAt: string
  can: FileAction[]
  /** Browse only: the bytes of the live files the viewer can see below it, and how many items it holds */
  size?: number
  itemCount?: number
}

export type Section = "mine" | "shared" | "recent" | "trash" | "project"
export type SortKey = "name" | "updated" | "size"
export type Cursor = [string, string]
export type BrowseOptions = {
  section: Section
  projectId: string | null
  folderId: string | null
  sort: SortKey
  dir: "asc" | "desc"
  cursor: Cursor | null
}
type SearchOptions = {
  /** Empty with a filter set, which then lists everything the filter matches */
  q?: string
  /** Limits the search to one project, or to one folder and everything below it */
  projectId?: string
  folderId?: string
  type?: "image" | "document" | "pdf" | "video" | "audio" | "paper" | "board" | "other"
  owner?: "me" | "others"
  after?: string
  before?: string
}

export function fileKind(mimeType: string | null): FileKind {
  const type = (mimeType ?? "").toLowerCase()
  if (type.startsWith("image/")) return "image"
  if (type === "application/pdf") return "pdf"
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  return "file"
}

export const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url")

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/

/** A timestamp Postgres reads back, so February 30th is refused here rather than by the database */
function isTimestamp(key: string): boolean {
  if (!TIMESTAMP_SHAPE.test(key)) return false
  const seconds = `${key.slice(0, 10)}T${key.slice(11, 19)}`
  const ms = Date.parse(`${seconds}Z`)
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(seconds)
}

const KEY_SHAPES: Record<SortKey, (key: string) => boolean> = {
  // eslint-disable-next-line no-control-regex -- a name key holds anything but NUL
  name: (key) => /^[^\u0000]{0,255}$/u.test(key),
  updated: isTimestamp,
  size: (key) => /^\d{1,15}$/.test(key),
}

/** The cursor of a page sorted by `sort`, or null when it is unreadable or made for another sort */
export function decodeCursor(value: string, sort: SortKey): Cursor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null
  const [key, id] = parsed
  if (typeof key !== "string" || typeof id !== "string") return null
  return KEY_SHAPES[sort](key) && UUID_SHAPE.test(id) ? [key, id] : null
}

/** `%`, `_` and the escape itself match only themselves */
export const likePattern = (q: string): string =>
  `%${[...q.toLowerCase()].map((c) => (c === "%" || c === "_" || c === "\\" ? `\\${c}` : c)).join("")}%`

/* The fragments below read the viewer's id as V and workspace as O, against the aliases each one names */

export const ids = (v: FileViewer) => ({ V: sql`${v.userId}::uuid`, O: sql`${v.organizationId}::uuid` })

/** A task `t` the viewer can open, as `canAccessTask` decides, so never one in Trash */
function taskReach(v: FileViewer): SQL {
  const { V, O } = ids(v)
  return sql`t.organization_id = ${O} and ${LIVE_TASK_SQL("t")} and (
    (t.project_id is null and t.assigned_to = ${V})
    or (t.project_id is not null and exists (
      select 1 from project_members tpm join projects tp on tp.id = tpm.project_id
      where tpm.project_id = t.project_id and tpm.user_id = ${V} and tp.organization_id = ${O} and ${LIVE_PROJECT_SQL("tp")})))`
}

/**
 * A link `l` the viewer can reach: a group chat they are in, a DM with a user still in the workspace or since
 * removed from it, or a task or comment they can open. `fileRole` keeps a removed owner's deadline
 */
function linkReach(v: FileViewer): SQL {
  const { V, O } = ids(v)
  // trash: taskReach leaves out tasks in Trash and those of projects in Trash, and a project chat counts only while its project is live
  return sql`l.organization_id = ${O} and (
    exists (
      select 1 from messages m
      join group_chats g on g.id = m.thread_id
      join group_chat_members gm on gm.group_chat_id = g.id and gm.user_id = ${V}
      where m.id = l.message_id and m.thread_type = 'group' and g.organization_id = ${O}
        and (g.project_id is null or exists (select 1 from projects gp where gp.id = g.project_id and ${LIVE_PROJECT_SQL("gp")})))
    or exists (
      select 1 from messages m
      join users other on other.id = (case when m.sender_id = ${V} then m.recipient_id else m.sender_id end)
      where m.id = l.message_id and m.thread_type is null and m.recipient_id is not null
        and (m.sender_id = ${V} or m.recipient_id = ${V})
        and (
          (m.organization_id = ${O} and exists (
            select 1 from organization_members om where om.user_id = other.id and om.organization_id = ${O}))
          or (other.removed_at is not null and m.organization_id = ${O})))
    or exists (select 1 from tasks t where t.id = l.task_id and ${taskReach(v)})
    or exists (
      select 1 from task_comments c join tasks t on t.id = c.task_id
      where c.id = l.comment_id and c.organization_id = ${O} and ${taskReach(v)}))`
}

/** Every folder granted to the viewer and every folder below one, with who granted it */
function grantedCte(v: FileViewer): SQL {
  const { V, O } = ids(v)
  return sql`granted(id, granted_by, depth) as (
    select ff.id, g.granted_by, 0 from file_grants g join file_folders ff on ff.id = g.folder_id
    where g.user_id = ${V} and g.organization_id = ${O} and ff.organization_id = ${O}
    union all
    select ff.id, gr.granted_by, gr.depth + 1 from file_folders ff join granted gr on ff.parent_folder_id = gr.id
    where ff.organization_id = ${O} and gr.depth < ${MAX_FOLDER_DEPTH}::int)`
}

/** A folder the viewer can reach: their own personal folder, a folder of a project they are in, or one inside a grant */
function folderReach(v: FileViewer, column: SQL): SQL {
  const { V, O } = ids(v)
  return sql`coalesce(${column} in (select id from granted) or exists (
    select 1 from file_folders rf where rf.id = ${column} and rf.organization_id = ${O} and (
      (rf.project_id is null and rf.created_by = ${V})
      or exists (
        select 1 from project_members rpm join projects rp on rp.id = rpm.project_id
        where rpm.project_id = rf.project_id and rpm.user_id = ${V} and rp.organization_id = ${O} and ${LIVE_PROJECT_SQL("rp")}))), false)`
}

const linked = (v: FileViewer) => sql`exists (select 1 from file_links l where l.file_id = f.id and ${linkReach(v)})`

/** A grant on the file, or with `throughFolders` on a folder above it */
function granted(v: FileViewer, throughFolders = true): SQL {
  const { V, O } = ids(v)
  const folders = throughFolders ? sql` or f.folder_id in (select id from granted)` : sql``
  return sql`coalesce(exists (
    select 1 from file_grants g
    where g.file_id = f.id and g.user_id = ${V} and g.organization_id = ${O}
  )${folders}, false)`
}

/** The viewer's role in the project `projectColumn` names, as `pr.role`, where the creator counts as admin */
function projectRoleJoin(v: FileViewer, projectColumn: SQL): SQL {
  const { V, O } = ids(v)
  return sql`left join lateral (
    select case when count(*) = 0 then null
      when bool_or(pm.role = 'admin' or p.created_by = ${V}) then 'admin' else 'member' end as role
    from project_members pm join projects p on p.id = pm.project_id
    where pm.project_id = ${projectColumn} and pm.user_id = ${V} and p.organization_id = ${O} and ${LIVE_PROJECT_SQL("p")}) pr on true`
}

/** Avatars and the images inside papers and boards never list as files */
const fileInOrg = (v: FileViewer) => sql`f.kind = 'file' and f.organization_id = ${ids(v).O}`
const liveFile = sql`f.deleted_at is null and f.is_draft = false`
const beforeDeadline = sql`(f.project_id is not null or u.removed_at is null
  or (now() at time zone 'utc') < u.removed_at + make_interval(days => ${REMOVAL_DAYS}::int))`

/** Posted only in a chat: a message links it, no task or comment does, and it sits in no folder */
function chatOnly(v: FileViewer): SQL {
  const { O } = ids(v)
  const inOrg = sql`cl.organization_id = ${O}`
  return sql`(f.folder_id is null
    and exists (select 1 from file_links cl where cl.file_id = f.id and cl.message_id is not null and ${inOrg})
    and not exists (select 1 from file_links cl where cl.file_id = f.id and ${inOrg}
      and (cl.task_id is not null or cl.comment_id is not null)))`
}

/** Project chat files stay with the chat's members, so a workspace admin outside the project never sees them */
const notChatForOutsiders = (v: FileViewer) => sql`(f.project_id is null or pr.role is not null or not ${chatOnly(v)})`

/** Own files, project files of the viewer's projects, and anything reachable through a link or a grant */
function reachable(v: FileViewer): SQL {
  return sql`((f.project_id is null and f.uploaded_by = ${ids(v).V}) or pr.role is not null or ${linked(v)} or ${granted(v)})`
}

const inFolder = (folderId: string | null) => (folderId ? sql`f.folder_id = ${folderId}::uuid` : sql`f.folder_id is null`)
const underFolder = (folderId: string | null) =>
  folderId ? sql`ff.parent_folder_id = ${folderId}::uuid` : sql`ff.parent_folder_id is null`

export type FileQueryRow = {
  id: string
  file_name: string
  file_size: number
  mime_type: string | null
  alt_text: string | null
  project_id: string | null
  folder_id: string | null
  organization_id: string
  kind: string
  doc_type: DocType | null
  is_draft: boolean
  updated_at: string
  deleted_at: string | null
  uploaded_by: string
  first_name: string | null
  last_name: string | null
  avatar_url: string | null
  owner_removed_at: string | null
  project_role: "admin" | "member" | "viewer" | null
  sees_link: boolean
  has_grant: boolean
  folder_visible: boolean
  chat_only: boolean
  done_via: Via | null
  sort_key: string
}

/** Selects files `f` with their owner and the facts the rules need, under `where`, in one statement */
function fileSelect(v: FileViewer, where: SQL, order: SQL, sortKey: SQL, limit: number, flags: boolean): SQL {
  const seesLink = flags ? linked(v) : sql`false`
  const hasGrant = flags ? granted(v) : sql`false`
  return sql`with recursive ${grantedCte(v)}
    select f.id, f.file_name, f.file_size, f.mime_type, f.alt_text, f.project_id, f.folder_id, f.organization_id,
      f.kind, f.doc_type, f.is_draft, f.updated_at::text as updated_at, f.deleted_at::text as deleted_at, f.uploaded_by,
      u.first_name, u.last_name, u.avatar_url, u.removed_at::text as owner_removed_at,
      pr.role as project_role, ${seesLink} as sees_link, ${hasGrant} as has_grant,
      ${folderReach(v, sql`f.folder_id`)} as folder_visible, ${chatOnly(v)} as chat_only, f.done_via, (${sortKey})::text as sort_key
    from file_attachments f
    join users u on u.id = f.uploaded_by
    ${projectRoleJoin(v, sql`f.project_id`)}
    where ${where}
    order by ${order}
    limit ${limit}::int`
}

const SORT_COLUMNS: Record<SortKey, { key: SQL; cast: SQL }> = {
  name: { key: sql`lower(f.file_name)`, cast: sql`text` },
  updated: { key: sql`f.updated_at`, cast: sql`timestamp` },
  size: { key: sql`f.file_size`, cast: sql`bigint` },
}

function sectionWhere(v: FileViewer, options: BrowseOptions): SQL {
  const { V } = ids(v)
  switch (options.section) {
    case "mine":
      return sql`${fileInOrg(v)} and ${liveFile} and f.uploaded_by = ${V} and f.project_id is null and ${inFolder(options.folderId)}`
    case "project":
      return sql`${fileInOrg(v)} and ${liveFile} and f.project_id = ${options.projectId}::uuid and ${inFolder(options.folderId)}
        and ${notChatForOutsiders(v)}`
    case "shared": {
      // At the root a granted folder stands for its contents, which show when browsing into it
      const place = options.folderId ? sql` and ${inFolder(options.folderId)}` : sql``
      return sql`${fileInOrg(v)} and ${liveFile} and ${beforeDeadline} and f.uploaded_by <> ${V}
        and (pr.role is not null or ${linked(v)} or ${granted(v, options.folderId !== null)})${place}`
    }
    case "trash":
      return sql`${fileInOrg(v)} and f.deleted_at is not null and (f.trash_root = f.id or f.trash_root is null)
        and ((f.project_id is null and f.uploaded_by = ${V})
          or (f.project_id is not null and (pr.role = 'admin' or (f.uploaded_by = ${V} and pr.role is not null))))`
    case "recent":
      return sql`${fileInOrg(v)} and ${liveFile} and ${beforeDeadline} and ${reachable(v)}`
  }
}

/** One page of a section's files, and the cursor of the next page when there is one */
export async function listFiles(v: FileViewer, options: BrowseOptions): Promise<{ rows: FileQueryRow[]; nextCursor: string | null }> {
  const flags = options.section === "shared" || options.section === "recent"
  if (options.section === "recent") {
    const { V, O } = ids(v)
    const key = sql`greatest(f.updated_at, (
      select max(l.created_at) from file_links l
      where l.file_id = f.id and l.created_by = ${V} and l.organization_id = ${O}))`
    const rows = await db.execute<FileQueryRow>(
      fileSelect(v, sectionWhere(v, options), sql`${key} desc, f.id desc`, key, RECENT_LIMIT, flags),
    )
    return { rows: [...rows], nextCursor: null }
  }
  const { key, cast } = SORT_COLUMNS[options.sort]
  const dir = options.dir === "asc" ? sql`asc` : sql`desc`
  const after = options.cursor
    ? sql` and (${key}, f.id) ${options.dir === "asc" ? sql`>` : sql`<`} (${options.cursor[0]}::${cast}, ${options.cursor[1]}::uuid)`
    : sql``
  const where = sql`${sectionWhere(v, options)}${after}`
  const rows = [...(await db.execute<FileQueryRow>(fileSelect(v, where, sql`${key} ${dir}, f.id ${dir}`, key, PAGE_SIZE + 1, flags)))]
  const page = rows.slice(0, PAGE_SIZE)
  const last = page[page.length - 1]
  return { rows: page, nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor([last.sort_key, last.id]) : null }
}

const SEARCH_TYPES: Record<NonNullable<SearchOptions["type"]>, SQL> = {
  image: sql`f.mime_type like 'image/%'`,
  pdf: sql`f.mime_type = 'application/pdf'`,
  video: sql`f.mime_type like 'video/%'`,
  audio: sql`f.mime_type like 'audio/%'`,
  paper: sql`f.doc_type = 'paper'`,
  board: sql`f.doc_type = 'board'`,
  document: sql`(f.mime_type like 'text/%' or f.mime_type like 'application/vnd.openxmlformats%'
    or f.mime_type like 'application/vnd.oasis.opendocument%'
    or f.mime_type in ('application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
      'application/rtf', 'application/json', 'application/xml'))`,
  other: sql`true`,
}

/** A folder and every live folder below it, in the viewer's workspace */
function folderSubtree(v: FileViewer, folderId: string): SQL {
  const { O } = ids(v)
  return sql`(with recursive tree(id, depth) as (
      select id, 0 from file_folders where id = ${folderId}::uuid and organization_id = ${O} and deleted_at is null
      union all
      select f.id, t.depth + 1 from file_folders f join tree t on f.parent_folder_id = t.id
      where f.organization_id = ${O} and f.deleted_at is null and t.depth < ${MAX_FOLDER_DEPTH}::int)
    select id from tree)`
}

/** Names and filters, over everything the viewer can open that is not in Trash, or within one place */
export async function searchFiles(v: FileViewer, options: SearchOptions, limit = SEARCH_LIMIT): Promise<FileQueryRow[]> {
  if (limit <= 0) return []
  const { V } = ids(v)
  const filters: SQL[] = []
  if (options.q) filters.push(sql`lower(f.file_name) like ${likePattern(options.q)} escape '\\'`)
  if (options.projectId) filters.push(sql`f.project_id = ${options.projectId}::uuid`)
  if (options.folderId) filters.push(sql`f.folder_id in ${folderSubtree(v, options.folderId)}`)
  if (options.type === "other") {
    const known = (["image", "pdf", "video", "audio", "document", "paper", "board"] as const).map((type) => SEARCH_TYPES[type])
    filters.push(sql`not coalesce(${sql.join(known, sql` or `)}, false)`)
  } else if (options.type) filters.push(SEARCH_TYPES[options.type])
  if (options.owner === "me") filters.push(sql`f.uploaded_by = ${V}`)
  if (options.owner === "others") filters.push(sql`f.uploaded_by <> ${V}`)
  if (options.after) filters.push(sql`f.updated_at >= (${options.after}::timestamptz at time zone 'utc')`)
  if (options.before) filters.push(sql`f.updated_at < (${options.before}::timestamptz at time zone 'utc')`)
  const narrowed = filters.length ? sql` and ${sql.join(filters, sql` and `)}` : sql``
  const where = sql`${fileInOrg(v)} and ${liveFile} and ${beforeDeadline} and ${reachable(v)}
    and ${notChatForOutsiders(v)}${narrowed}`
  const key = sql`f.updated_at`
  return [...(await db.execute<FileQueryRow>(fileSelect(v, where, sql`f.updated_at desc, f.id desc`, key, limit, true)))]
}

type FolderQueryRow = {
  id: string
  name: string
  color: string | null
  icon: string | null
  parent_folder_id: string | null
  project_id: string | null
  organization_id: string
  created_by: string
  updated_at: string
  deleted_at: string | null
  project_role: "admin" | "member" | "viewer" | null
  has_grant: boolean
  parent_visible: boolean
  contents?: FolderContents
}

const folderOwnerLive = sql`(ff.project_id is not null or fu.removed_at is null
  or (now() at time zone 'utc') < fu.removed_at + make_interval(days => ${REMOVAL_DAYS}::int))`

/** Folders `ff` under `where`. A removed owner's folders go at their deadline, like their files */
function folderSelect(v: FileViewer, where: SQL, order: SQL, limit: number): SQL {
  return sql`with recursive ${grantedCte(v)}
    select ff.id, ff.name, ff.color, ff.icon, ff.parent_folder_id, ff.project_id, ff.organization_id, ff.created_by,
      ff.updated_at::text as updated_at, ff.deleted_at::text as deleted_at, pr.role as project_role,
      ff.id in (select id from granted) as has_grant, ${folderReach(v, sql`ff.parent_folder_id`)} as parent_visible
    from file_folders ff
    join users fu on fu.id = ff.created_by
    ${projectRoleJoin(v, sql`ff.project_id`)}
    where ff.organization_id = ${ids(v).O} and ${where} and ${folderOwnerLive}
    order by ${order}
    limit ${limit}::int`
}

type FolderContents = { size: number; itemCount: number }

/** The files a section shows inside a folder, as browsing into it lists them */
function contentFiles(v: FileViewer, options: BrowseOptions): SQL {
  const { V } = ids(v)
  switch (options.section) {
    case "mine":
      return sql`${fileInOrg(v)} and ${liveFile} and f.uploaded_by = ${V} and f.project_id is null`
    case "project":
      return sql`${fileInOrg(v)} and ${liveFile} and f.project_id = ${options.projectId}::uuid`
    case "shared":
      return sql`${fileInOrg(v)} and ${liveFile} and ${beforeDeadline} and f.uploaded_by <> ${V} and f.folder_id in (select id from granted)`
    default:
      return sql`false`
  }
}

/**
 * The size and item count of each folder, in one statement. A folder's subtree keeps to the folders the section
 * could browse into, and its files to those the section would list there, so nothing counted is out of reach
 */
async function folderContents(v: FileViewer, options: BrowseOptions, folderIds: string[]): Promise<Map<string, FolderContents>> {
  const found = new Map<string, FolderContents>()
  if (folderIds.length === 0) return found
  const { O } = ids(v)
  const scope = sql`ff.organization_id = ${O} and ff.deleted_at is null and ${folderOwnerLive} and ${sectionScope(v, options)}`
  const list = sql.join(
    folderIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )
  const rows = await db.execute<{ id: string; size: number; item_count: number }>(sql`with recursive ${grantedCte(v)},
    tree(root, id, depth) as (
      select ff.id, ff.id, 0 from file_folders ff join users fu on fu.id = ff.created_by
      where ff.id in (${list}) and ${scope}
      union all
      select t.root, ff.id, t.depth + 1 from file_folders ff join users fu on fu.id = ff.created_by
      join tree t on ff.parent_folder_id = t.id
      where ${scope} and t.depth < ${MAX_FOLDER_DEPTH}::int)
    select t.root as id, coalesce(sum(f.file_size), 0)::float8 as size,
      (count(f.id) filter (where t.depth = 0) + count(distinct t.id) filter (where t.depth = 1))::int as item_count
    from tree t
    left join (file_attachments f join users u on u.id = f.uploaded_by) on f.folder_id = t.id and ${contentFiles(v, options)}
    group by t.root`)
  for (const row of rows) found.set(row.id, { size: row.size, itemCount: row.item_count })
  return found
}

/** The folders a section shows at one level, all at once on the first page */
export async function listFolders(v: FileViewer, options: BrowseOptions): Promise<FolderQueryRow[]> {
  const { V, O } = ids(v)
  let where: SQL
  switch (options.section) {
    case "mine":
      where = sql`ff.deleted_at is null and ff.project_id is null and ff.created_by = ${V} and ${underFolder(options.folderId)}`
      break
    case "project":
      where = sql`ff.deleted_at is null and ff.project_id = ${options.projectId}::uuid and ${underFolder(options.folderId)}`
      break
    case "shared":
      where = options.folderId
        ? sql`ff.deleted_at is null and ${underFolder(options.folderId)}`
        : sql`ff.deleted_at is null and ff.created_by <> ${V} and exists (
            select 1 from file_grants g where g.folder_id = ff.id and g.user_id = ${V}
            and g.organization_id = ${O})`
      break
    case "trash":
      where = sql`ff.deleted_at is not null and ff.trash_root = ff.id and ((ff.project_id is null and ff.created_by = ${V})
        or (ff.project_id is not null and pr.role = 'admin'))`
      break
    case "recent":
      return []
  }
  const order = options.sort === "updated" ? sql`ff.updated_at desc, ff.id desc` : sql`lower(ff.name) asc, ff.id asc`
  const rows = [...(await db.execute<FolderQueryRow>(folderSelect(v, where, order, FOLDER_LIMIT)))]
  if (options.section === "trash") return rows
  const contents = await folderContents(
    v,
    options,
    rows.map((row) => row.id),
  )
  const listed = rows.map((row) => ({ ...row, contents: contents.get(row.id) ?? { size: 0, itemCount: 0 } }))
  if (options.sort !== "size") return listed
  const dir = options.dir === "asc" ? 1 : -1
  return listed.sort((a, b) => (a.contents.size - b.contents.size) * dir)
}

/** Where the shared Trash list continues, newest deleted first, as a fixed-width `deleted_at` and an id */
export type TrashPage = { before: [string, string] | null; limit: number }
type TrashFilesOf = "all" | "files" | "docs"

export type TrashFileRow = {
  id: string
  name: string
  doc_type: DocType | null
  kind: string
  is_draft: boolean
  organization_id: string
  owner_id: string
  owner_removed_at: string | null
  project_id: string | null
  project_role: "admin" | "member" | null
  project_name: string | null
  project_trashed: boolean
  folder_id: string | null
  folder_name: string | null
  deleted_at: string
  deleted_by: string | null
  deleter_first: string | null
  deleter_last: string | null
  deleted_via: Via | null
}
export type TrashFolderRow = Omit<TrashFileRow, "doc_type" | "kind" | "is_draft" | "owner_removed_at">

/** A Trash row's `deleted_at` as fixed-width text, the key its cursor carries */
export const trashKeyOf = (column: SQL) => sql`to_char(${column}, 'YYYY-MM-DD HH24:MI:SS.US')`

export const trashAfter = (page: TrashPage, at: SQL, id: SQL) =>
  page.before ? sql` and (${at}, ${id}) < (${page.before[0]}::timestamp, ${page.before[1]}::uuid)` : sql``

/** The viewer's role in a project whether or not it is in Trash, read from the membership, where the creator counts as admin */
function trashRoleJoin(v: FileViewer, projectColumn: SQL): SQL {
  const { V, O } = ids(v)
  // trash: what was trashed on its own inside a project now in Trash still shows to those who could restore it
  return sql`left join lateral (
    select case when count(*) = 0 then null
      when bool_or(pm.role = 'admin' or p.created_by = ${V}) then 'admin' else 'member' end as role
    from project_members pm join projects p on p.id = pm.project_id
    where pm.project_id = ${projectColumn} and pm.user_id = ${V} and p.organization_id = ${O}) pr on true`
}

/** The project a Trash row was in, live or in Trash */
function trashProjectJoin(v: FileViewer, projectColumn: SQL): SQL {
  // trash: Trash names the project an item was in, and whether that project is in Trash too
  return sql`left join projects tp on tp.id = ${projectColumn} and tp.organization_id = ${ids(v).O}`
}

/**
 * The files and docs in the viewer's Trash, as the Files Trash shows them, trashed on their own and not with a project.
 * A project's go to its admins, and to their uploader while a member, its own Trash or not
 */
export async function trashFiles(v: FileViewer, of: TrashFilesOf, page: TrashPage): Promise<TrashFileRow[]> {
  const { V } = ids(v)
  const kind = of === "files" ? sql` and f.doc_type is null` : of === "docs" ? sql` and f.doc_type is not null` : sql``
  const rows = await db.execute<TrashFileRow>(sql`
    select f.id, f.file_name as name, f.doc_type, f.kind, f.is_draft, f.organization_id, f.uploaded_by as owner_id,
      u.removed_at::text as owner_removed_at, f.project_id, pr.role as project_role, tp.name as project_name, tp.deleted_at is not null as project_trashed,
      case when pf.deleted_at is null then pf.id end as folder_id, pf.name as folder_name, ${trashKeyOf(sql`f.deleted_at`)} as deleted_at, f.deleted_by,
      du.first_name as deleter_first, du.last_name as deleter_last, f.deleted_via
    from file_attachments f
    join users u on u.id = f.uploaded_by
    ${trashRoleJoin(v, sql`f.project_id`)}
    ${trashProjectJoin(v, sql`f.project_id`)}
    left join file_folders pf on pf.id = f.folder_id and pf.organization_id = ${ids(v).O}
    left join users du on du.id = f.deleted_by
    where ${fileInOrg(v)} and f.deleted_at is not null and (f.trash_root = f.id or f.trash_root is null)${kind}
      and ((f.project_id is null and f.uploaded_by = ${V})
        or (f.project_id is not null and (pr.role = 'admin' or (f.uploaded_by = ${V} and pr.role is not null))))
      ${trashAfter(page, sql`f.deleted_at`, sql`f.id`)}
    order by f.deleted_at desc, f.id desc
    limit ${page.limit}::int`)
  return [...rows]
}

/** The folders in the viewer's Trash: their own, and a project's for its admins */
export async function trashFolders(v: FileViewer, page: TrashPage): Promise<TrashFolderRow[]> {
  const { V, O } = ids(v)
  const rows = await db.execute<TrashFolderRow>(sql`
    select ff.id, ff.name, ff.organization_id, ff.created_by as owner_id, ff.project_id, pr.role as project_role,
      tp.name as project_name, tp.deleted_at is not null as project_trashed,
      case when pf.deleted_at is null then pf.id end as folder_id, pf.name as folder_name, ${trashKeyOf(sql`ff.deleted_at`)} as deleted_at, ff.deleted_by,
      du.first_name as deleter_first, du.last_name as deleter_last, ff.deleted_via
    from file_folders ff
    ${trashRoleJoin(v, sql`ff.project_id`)}
    ${trashProjectJoin(v, sql`ff.project_id`)}
    left join file_folders pf on pf.id = ff.parent_folder_id and pf.organization_id = ${O}
    left join users du on du.id = ff.deleted_by
    where ff.organization_id = ${O} and ff.deleted_at is not null and ff.trash_root = ff.id
      and ((ff.project_id is null and ff.created_by = ${V}) or (ff.project_id is not null and pr.role = 'admin'))
      ${trashAfter(page, sql`ff.deleted_at`, sql`ff.id`)}
    order by ff.deleted_at desc, ff.id desc
    limit ${page.limit}::int`)
  return [...rows]
}

/** Folders by name: the viewer's own, their projects' and those granted to them */
export async function searchFolders(
  v: FileViewer,
  q: string,
  place: Pick<SearchOptions, "projectId" | "folderId"> = {},
): Promise<FolderQueryRow[]> {
  const project = place.projectId ? sql` and ff.project_id = ${place.projectId}::uuid` : sql``
  const folder = place.folderId ? sql` and ff.id <> ${place.folderId}::uuid and ff.id in ${folderSubtree(v, place.folderId)}` : sql``
  const where = sql`ff.deleted_at is null and lower(ff.name) like ${likePattern(q)} escape '\\'
    and ((ff.project_id is null and ff.created_by = ${ids(v).V}) or pr.role is not null or ff.id in (select id from granted))${project}${folder}`
  return [...(await db.execute<FolderQueryRow>(folderSelect(v, where, sql`lower(ff.name) asc, ff.id asc`, SEARCH_LIMIT)))]
}

/**
 * Which folders a section may show: the viewer's own, the project's, or those inside a grant. A project's folders
 * show to its members and to the workspace's admins, who read every project
 */
function sectionScope(v: FileViewer, options: BrowseOptions): SQL {
  const { V, O } = ids(v)
  return options.section === "mine"
    ? sql`ff.project_id is null and ff.created_by = ${V}`
    : options.section === "project"
      ? sql`ff.project_id = ${options.projectId}::uuid
          and (exists (select 1 from project_members spm where spm.project_id = ff.project_id and spm.user_id = ${V})
            or exists (select 1 from organization_members som
              where som.user_id = ${V} and som.organization_id = ${O} and som.role = 'admin'))`
      : options.section === "shared"
        ? sql`ff.id in (select id from granted)`
        : sql`false`
}

type TrailStep = { id: string; name: string; color: FolderColor | null }

/**
 * The open folder and the folders above it that the section may show, from the outermost down. In Shared with
 * me it starts at the granted folder. Empty when the open folder itself is out of reach
 */
export async function folderTrail(v: FileViewer, options: BrowseOptions): Promise<TrailStep[]> {
  if (!options.folderId) return []
  const { O } = ids(v)
  const chain = sql`(with recursive chain(id, parent, depth) as (
      select id, parent_folder_id, 0 from file_folders where id = ${options.folderId}::uuid and organization_id = ${O}
      union all
      select f.id, f.parent_folder_id, c.depth + 1 from file_folders f join chain c on f.id = c.parent
      where f.organization_id = ${O} and c.depth < ${MAX_FOLDER_DEPTH}::int)
    select id from chain)`
  const where = sql`ff.id in ${chain} and ff.deleted_at is null and ${sectionScope(v, options)}`
  const rows = await db.execute<FolderQueryRow>(folderSelect(v, where, sql`ff.id`, MAX_FOLDER_DEPTH + 1))
  const byId = new Map(rows.map((row) => [row.id, row]))
  const trail: TrailStep[] = []
  let id: string | null = options.folderId
  while (id && trail.length <= MAX_FOLDER_DEPTH) {
    const folder = byId.get(id)
    if (!folder) break
    trail.unshift({ id: folder.id, name: folder.name, color: folder.color as FolderColor | null })
    id = folder.parent_folder_id
  }
  return trail
}

/** A project's files and folders as a workspace admin outside it sees them in its Files view, which only reads */
export function asProjectViewer<Row extends { project_role: FileQueryRow["project_role"] }>(rows: Row[]): Row[] {
  return rows.map((row) => ({
    ...row,
    project_role: row.project_role ?? "viewer",
    ...("folder_visible" in row ? { folder_visible: true } : {}),
    ...("parent_visible" in row ? { parent_visible: true } : {}),
  }))
}

/**
 * Where an upload or a new folder goes. A folder decides its project, and a project needs the viewer to be a
 * member. Null when either is not the viewer's to use, and `read-only` for a workspace admin outside the project
 */
export async function resolvePlace(
  v: FileViewer,
  projectId: string | null,
  folderId: string | null,
): Promise<{ projectId: string | null; folderId: string | null } | "read-only" | null> {
  let project = projectId
  if (folderId) {
    const [folder] = await db
      .select({ projectId: fileFolders.projectId, createdBy: fileFolders.createdBy })
      .from(fileFolders)
      .where(and(eq(fileFolders.id, folderId), eq(fileFolders.organizationId, v.organizationId), isNull(fileFolders.deletedAt)))
    if (!folder || (project && folder.projectId !== project)) return null
    if (!folder.projectId && folder.createdBy !== v.userId) return null
    project = folder.projectId
  }
  if (project) {
    const access = await projectReadAccess(v.userId, v.organizationId, project)
    if (!access) return null
    if (access.role === ADMIN_VIEWER) return "read-only"
  }
  return { projectId: project, folderId }
}

/** A live folder the viewer may put things in: their own personal folder, or a folder of `projectId` */
export async function placeFolder(
  v: FileViewer,
  folderId: string,
  projectId: string | null,
  executor: Executor = db,
): Promise<FolderRow | null> {
  const [folder] = await executor
    .select()
    .from(fileFolders)
    .where(
      and(
        eq(fileFolders.id, folderId),
        eq(fileFolders.organizationId, v.organizationId),
        isNull(fileFolders.deletedAt),
        projectId ? eq(fileFolders.projectId, projectId) : and(isNull(fileFolders.projectId), eq(fileFolders.createdBy, v.userId)),
      ),
    )
  return folder ?? null
}

type ContextRow = {
  id: string
  link_by: string | null
  link_first: string | null
  link_last: string | null
  message_id: string | null
  thread_type: string | null
  thread_id: string | null
  sender_id: string | null
  recipient_id: string | null
  chat_name: string | null
  task_id: string | null
  task_title: string | null
  task_project_slug: string | null
  project_name: string | null
  project_slug: string | null
  granted_by: string | null
  grant_first: string | null
  grant_last: string | null
}

/** Where each file reached the viewer, from the most recent link they can reach, in one statement */
export async function contextLines(v: FileViewer, rows: FileQueryRow[]): Promise<Map<string, FileContext>> {
  const others = rows.filter((row) => row.uploaded_by !== v.userId)
  const found = new Map<string, FileContext>()
  if (others.length === 0) return found
  const { V, O } = ids(v)
  const list = sql.join(
    others.map((row) => sql`${row.id}::uuid`),
    sql`, `,
  )
  const lines = await db.execute<ContextRow>(sql`with recursive ${grantedCte(v)}
    select f.id, lk.created_by as link_by, lu.first_name as link_first, lu.last_name as link_last,
      lk.message_id, m.thread_type, m.thread_id, m.sender_id, m.recipient_id, gc.name as chat_name,
      tk.id as task_id, tk.title as task_title, tkp.slug as task_project_slug,
      fp.name as project_name, fp.slug as project_slug,
      gr.granted_by, gu.first_name as grant_first, gu.last_name as grant_last
    from file_attachments f
    left join lateral (
      select l.created_by, l.message_id, l.task_id, l.comment_id from file_links l
      where l.file_id = f.id and ${linkReach(v)}
      order by l.created_at desc, l.id desc limit 1) lk on true
    left join users lu on lu.id = lk.created_by
    left join messages m on m.id = lk.message_id
    left join group_chats gc on gc.id = m.thread_id and m.thread_type = 'group' and gc.organization_id = ${O}
    left join task_comments lc on lc.id = lk.comment_id
    left join tasks tk on tk.id = coalesce(lk.task_id, lc.task_id) and ${LIVE_TASK_SQL("tk")}
    left join projects tkp on tkp.id = tk.project_id and tkp.organization_id = ${O} and ${LIVE_PROJECT_SQL("tkp")}
    left join projects fp on fp.id = f.project_id and fp.organization_id = ${O} and ${LIVE_PROJECT_SQL("fp")}
      and exists (select 1 from project_members fpm where fpm.project_id = fp.id and fpm.user_id = ${V})
    left join lateral (
      select gs.granted_by from (
        select fg.granted_by, 0 as rank from file_grants fg
        where fg.file_id = f.id and fg.user_id = ${V} and fg.organization_id = ${O}
        union all
        select granted.granted_by, 1 as rank from granted where granted.id = f.folder_id
      ) gs order by gs.rank limit 1) gr on true
    left join users gu on gu.id = gr.granted_by
    where f.id in (${list}) and f.organization_id = ${O}`)
  const owners = new Map(others.map((row) => [row.id, presenceName(row.first_name, row.last_name)]))
  for (const line of lines) {
    const context = contextOf(line, v, owners.get(line.id) ?? "Someone")
    if (context) found.set(line.id, context)
  }
  return found
}

function contextOf(line: ContextRow, v: FileViewer, ownerName: string): FileContext | null {
  if (line.link_by) {
    const by = presenceName(line.link_first, line.link_last)
    if (line.message_id && line.thread_type === "group" && line.thread_id) {
      return { by, where: line.chat_name ?? "Group chat", href: `/messages?group=${line.thread_id}` }
    }
    if (line.message_id) {
      const other = line.sender_id === v.userId ? line.recipient_id : line.sender_id
      return { by, where: "Direct message", href: `/messages?dm=${other}` }
    }
    if (line.task_id) {
      const href = line.task_project_slug
        ? `/project/${encodeURIComponent(line.task_project_slug)}?task=${line.task_id}`
        : `/?task=${line.task_id}`
      return { by, where: line.task_title ?? "A task", href }
    }
  }
  if (line.project_slug) {
    return { by: ownerName, where: line.project_name ?? "A project", href: `/project/${encodeURIComponent(line.project_slug)}` }
  }
  if (line.granted_by) {
    return { by: presenceName(line.grant_first, line.grant_last), where: "Shared with you", href: "/files/shared" }
  }
  return null
}

/** The earlier of a removed owner's deadline and the end of Trash */
function deadlineOf(file: { projectId: string | null; deletedAt: string | null }, ownerRemovedAt: string | null): string | null {
  const dates = [
    !file.projectId && ownerRemovedAt ? removalDeadline(ownerRemovedAt) : null,
    file.deletedAt ? removalDeadline(file.deletedAt) : null,
  ].filter((date): date is string => date !== null)
  return dates.length ? dates.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null
}

const allowed = (actions: FileAction[], facts: FileFacts, viewer: ViewerFacts) => actions.filter((action) => can(action, facts, viewer))

/** Papers and boards have no outside links and no alt text */
const NOT_FOR_DOCS = new Set<FileAction>(["link", "editAlt"])

const fileActions = (facts: FileFacts, viewer: ViewerFacts, docType: string | null) =>
  allowed(FILE_ACTIONS, facts, viewer).filter((action) => !docType || !NOT_FOR_DOCS.has(action))

export function fileDto(row: FileQueryRow, v: FileViewer, context: FileContext | null): FileDto {
  const facts: FileFacts = {
    organizationId: row.organization_id,
    ownerId: row.uploaded_by,
    ownerRemovedAt: row.owner_removed_at,
    projectId: row.project_id,
    kind: factsKind(row.kind),
    isDraft: row.is_draft,
    deletedAt: row.deleted_at,
    chatOnly: !!row.chat_only,
  }
  const viewer: ViewerFacts = { ...v, projectRole: row.project_role, seesALink: !!row.sees_link, hasGrant: !!row.has_grant }
  return {
    id: row.id,
    name: row.file_name,
    size: row.file_size,
    mimeType: row.mime_type || OPAQUE,
    kind: fileKind(row.mime_type),
    docType: row.doc_type,
    altText: row.alt_text,
    owner: { id: row.uploaded_by, name: presenceName(row.first_name, row.last_name), avatarUrl: row.avatar_url },
    projectId: row.project_id,
    folderId: row.folder_visible ? row.folder_id : null,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    removalDeadline: deadlineOf({ projectId: row.project_id, deletedAt: row.deleted_at }, row.owner_removed_at),
    context,
    can: fileActions(facts, viewer, row.doc_type),
    done_via: row.done_via ?? null,
  }
}

const PROJECT_ADMIN_ONLY = new Set<FileAction>(["trash", "restore", "purge"])

/** A project folder holds other users' files, so only a project admin may trash, restore or purge one */
function folderActions(facts: FileFacts, viewer: ViewerFacts): FileAction[] {
  const actions = allowed(FOLDER_ACTIONS, facts, viewer)
  return facts.projectId && viewer.projectRole !== "admin" ? actions.filter((action) => !PROJECT_ADMIN_ONLY.has(action)) : actions
}

export function folderDto(row: FolderQueryRow, v: FileViewer): FolderDto {
  const facts: FileFacts = {
    organizationId: row.organization_id,
    ownerId: row.created_by,
    ownerRemovedAt: null,
    projectId: row.project_id,
    kind: "file",
    isDraft: false,
    deletedAt: row.deleted_at,
  }
  const viewer: ViewerFacts = { ...v, projectRole: row.project_role, seesALink: false, hasGrant: !!row.has_grant }
  return {
    id: row.id,
    name: row.name,
    color: row.color as FolderColor | null,
    icon: row.icon as SymbolKey | null,
    parentId: row.parent_visible ? row.parent_folder_id : null,
    projectId: row.project_id,
    updatedAt: row.updated_at,
    can: folderActions(facts, viewer),
    ...(row.contents ? { size: row.contents.size, itemCount: row.contents.itemCount } : {}),
  }
}

/** A folder that `folderFacts` loaded */
export function loadedFolderDto(loaded: { folder: FolderRow; facts: FileFacts; viewer: ViewerFacts }): FolderDto {
  const { folder } = loaded
  return {
    id: folder.id,
    name: folder.name,
    color: folder.color as FolderColor | null,
    icon: folder.icon as SymbolKey | null,
    parentId: folder.parentFolderId,
    projectId: folder.projectId,
    updatedAt: folder.updatedAt,
    can: folderActions(loaded.facts, loaded.viewer),
  }
}

/** A file that `loadFileFacts` loaded, with its owner */
export async function loadedFileDto(loaded: { file: FileRow; facts: FileFacts; viewer: ViewerFacts }): Promise<FileDto> {
  const { file, facts, viewer } = loaded
  const owner = await db.query.users.findFirst({
    where: eq(users.id, file.uploadedBy),
    columns: { id: true, firstName: true, lastName: true, avatarUrl: true },
  })
  return {
    id: file.id,
    name: file.fileName,
    size: file.fileSize,
    mimeType: file.mimeType || OPAQUE,
    kind: fileKind(file.mimeType),
    docType: (file.docType as DocType | null) ?? null,
    altText: file.altText,
    owner: {
      id: file.uploadedBy,
      name: presenceName(owner?.firstName ?? null, owner?.lastName ?? null),
      avatarUrl: owner?.avatarUrl ?? null,
    },
    projectId: file.projectId,
    folderId: file.folderId,
    updatedAt: file.updatedAt,
    deletedAt: file.deletedAt,
    removalDeadline: deadlineOf(file, facts.ownerRemovedAt),
    context: null,
    can: fileActions(facts, viewer, file.docType),
    done_via: file.doneVia ?? null,
  }
}

type Usage = { person: number; workspace: number }

/**
 * The workspace's caps and what counts against them, in one statement. A user's usage is every file they
 * uploaded that is not a project file or an avatar, drafts and Trash included
 */
export async function capsAndUsage(v: FileViewer, executor: Executor = db): Promise<{ caps: Caps; usage: Usage }> {
  const { V, O } = ids(v)
  const [row] = await executor.execute<{
    person: number
    workspace: number
    per_person: number | null
    total: number | null
    max_file: number | null
  }>(sql`select
      (select coalesce(sum(a.file_size), 0)::float8 from file_attachments a
        where a.organization_id = ${O} and a.uploaded_by = ${V} and a.project_id is null and a.kind <> 'avatar') as person,
      (select coalesce(sum(a.file_size), 0)::float8 from file_attachments a
        where a.organization_id = ${O} and a.kind <> 'avatar') as workspace,
      o.storage_cap_per_person::float8 as per_person, o.storage_cap_total::float8 as total, o.max_file_size::float8 as max_file
    from organizations o where o.id = ${O}`)
  return {
    caps: { perPerson: row?.per_person ?? null, total: row?.total ?? null, maxFile: row?.max_file ?? null, ceiling: uploadCeiling() },
    usage: { person: row?.person ?? 0, workspace: row?.workspace ?? 0 },
  }
}

/** Makes concurrent uploads and copies in one workspace check their caps one at a time */
export async function lockUsage(tx: Tx, organizationId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`file-usage:${organizationId}`}, 0))`)
}
