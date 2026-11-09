import { and, asc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm"
import { addJob, defineJob } from "../jobs/queue"
import {
  db,
  fileAttachments,
  fileFolders,
  fileGrants,
  fileLinks,
  groupChats,
  messages,
  projectMembers,
  projects,
  type Executor,
  type Tx,
} from "../db"
import type { Via } from "../utils/aiTypes"
import type { ChatRef } from "../utils/chatAccess"
import { isDocPath } from "../utils/docAccess"
import { can, canLinkInto, factsKind, removalDeadline, type FileFacts, type ViewerFacts } from "../utils/fileAccess"
import { canAccessTask } from "../utils/taskAccess"
import { restoreBlock } from "../utils/trash"
import { chatForMessage, groupMemberIds } from "./chats"
import { closeDocConnections } from "./collab"
import { closeTrashedShares } from "./docCalls"
import { ADMIN_VIEWER, callerMembership, projectReadAccess } from "./projectAccess"
import { isMemberOf } from "./tenancy"
import { deleteObject } from "./storage"
import { emitToChat } from "./websocket"

export type FileRow = typeof fileAttachments.$inferSelect
export type FileViewer = { userId: string; organizationId: string; isOrgAdmin: boolean }
type FileActor = { userId: string; organizationId: string; isOrgAdmin?: boolean }
type LinkTarget = { messageId?: string; taskId?: string; commentId?: string }

/** Folder chains are walked at most this deep, so a cycle in `parent_folder_id` cannot loop */
export const MAX_FOLDER_DEPTH = 64

const viewerOf = (actor: FileActor): FileViewer => ({
  userId: actor.userId,
  organizationId: actor.organizationId,
  isOrgAdmin: actor.isOrgAdmin ?? false,
})

/**
 * The viewer's role in a project of their workspace, where its creator counts as admin while still a member. A
 * workspace admin outside the project is a `viewer`, which the rules let read only
 */
async function projectRoleOf(viewer: FileViewer, projectId: string, executor: Executor): Promise<ViewerFacts["projectRole"]> {
  const access = await projectReadAccess(viewer.userId, viewer.organizationId, projectId, executor)
  if (!access) return null
  if (access.role === ADMIN_VIEWER) return "viewer"
  return access.role === "admin" || access.project.createdBy === viewer.userId ? "admin" : "member"
}

type LinkedMessage = {
  senderId: string
  recipientId: string | null
  threadType: string | null
  threadId: string | null
  organizationId: string | null
  sender: { removedAt: string | null } | null
  recipient: { removedAt: string | null } | null
}

/** A DM with a user who has since left the workspace stays readable to the one still in it. `fileRole` keeps the deadline */
async function seesDmWithRemoved(message: LinkedMessage, viewer: FileViewer): Promise<boolean> {
  if (message.threadType || !message.recipientId || message.organizationId !== viewer.organizationId) return false
  const other = message.senderId === viewer.userId ? message.recipient : message.recipientId === viewer.userId ? message.sender : null
  if (!other?.removedAt) return false
  return isMemberOf(viewer.userId, viewer.organizationId)
}

/** A link to a message, task or comment the viewer can reach today */
async function seesALink(fileId: string, viewer: FileViewer, executor: Executor): Promise<boolean> {
  const member = { with: callerMembership(viewer.userId) } as const
  const person = { columns: { removedAt: true } } as const
  const links = await executor.query.fileLinks.findMany({
    where: and(eq(fileLinks.fileId, fileId), eq(fileLinks.organizationId, viewer.organizationId)),
    with: {
      message: {
        columns: { senderId: true, recipientId: true, threadType: true, threadId: true, organizationId: true },
        with: { sender: person, recipient: person },
      },
      task: { with: { project: member } },
      comment: { with: { task: { with: { project: member } } } },
    },
  })
  const reaches = (task: Parameters<typeof canAccessTask>[0] | null | undefined) =>
    !!task && canAccessTask(task, viewer.userId, viewer.organizationId)
  if (links.some((link) => reaches(link.task) || reaches(link.comment?.task))) return true
  for (const { message } of links) {
    if (!message) continue
    if (await chatForMessage(viewer.organizationId, viewer.userId, message)) return true
    if (await seesDmWithRemoved(message, viewer)) return true
  }
  return false
}

/** The folder and every folder above it */
export async function folderAncestors(folderId: string, organizationId: string, executor: Executor): Promise<string[]> {
  const rows = await executor.execute<{ id: string }>(sql`
    with recursive chain(id, parent, depth) as (
      select id, parent_folder_id, 0 from file_folders where id = ${folderId} and organization_id = ${organizationId}
      union all
      select f.id, f.parent_folder_id, c.depth + 1 from file_folders f join chain c on f.id = c.parent
      where f.organization_id = ${organizationId} and c.depth < ${MAX_FOLDER_DEPTH}
    )
    select distinct id from chain`)
  return rows.map((row) => row.id)
}

/** The folder and every folder below it that is not in Trash yet */
async function folderTree(folderId: string, organizationId: string, executor: Executor): Promise<string[]> {
  const rows = await executor.execute<{ id: string }>(sql`
    with recursive tree(id, depth) as (
      select id, 0 from file_folders where id = ${folderId} and organization_id = ${organizationId}
      union all
      select f.id, t.depth + 1 from file_folders f join tree t on f.parent_folder_id = t.id
      where f.organization_id = ${organizationId} and f.deleted_at is null and t.depth < ${MAX_FOLDER_DEPTH}
    )
    select distinct id from tree`)
  return rows.map((row) => row.id)
}

async function hasGrant(file: FileRow, viewer: FileViewer, executor: Executor): Promise<boolean> {
  const folders = file.folderId ? await folderAncestors(file.folderId, viewer.organizationId, executor) : []
  const on = folders.length ? or(eq(fileGrants.fileId, file.id), inArray(fileGrants.folderId, folders)) : eq(fileGrants.fileId, file.id)
  const [grant] = await executor
    .select({ id: fileGrants.id })
    .from(fileGrants)
    .where(and(eq(fileGrants.userId, viewer.userId), eq(fileGrants.organizationId, viewer.organizationId), on))
    .limit(1)
  return !!grant
}

/** Posted only in a chat: a message links it, no task or comment does, and it sits in no folder */
async function isChatOnly(file: FileRow, organizationId: string, executor: Executor): Promise<boolean> {
  if (!file.projectId || file.folderId) return false
  const links = await executor
    .select({ messageId: fileLinks.messageId, taskId: fileLinks.taskId, commentId: fileLinks.commentId })
    .from(fileLinks)
    .where(and(eq(fileLinks.fileId, file.id), eq(fileLinks.organizationId, organizationId)))
  return links.some((link) => link.messageId) && !links.some((link) => link.taskId || link.commentId)
}

/** The file with what the rules need about it and the viewer. Null outside the viewer's workspace */
export async function loadFileFacts(
  fileId: string,
  viewer: FileViewer,
  executor: Executor = db,
): Promise<{ file: FileRow; facts: FileFacts; viewer: ViewerFacts } | null> {
  const found = await executor.query.fileAttachments.findFirst({
    where: and(eq(fileAttachments.id, fileId), eq(fileAttachments.organizationId, viewer.organizationId)),
    with: { uploader: { columns: { removedAt: true } } },
  })
  if (!found) return null
  const { uploader, ...file } = found
  const facts: FileFacts = {
    organizationId: file.organizationId,
    ownerId: file.uploadedBy,
    ownerRemovedAt: uploader?.removedAt ?? null,
    projectId: file.projectId,
    kind: factsKind(file.kind),
    isDraft: file.isDraft,
    deletedAt: file.deletedAt,
    chatOnly: await isChatOnly(file, viewer.organizationId, executor),
  }
  const projectRole = file.projectId ? await projectRoleOf(viewer, file.projectId, executor) : null
  return {
    file,
    facts,
    viewer: {
      ...viewer,
      projectRole,
      seesALink: await seesALink(file.id, viewer, executor),
      hasGrant: await hasGrant(file, viewer, executor),
    },
  }
}

/** The project a message's chat belongs to. A DM has none */
export async function messageProjectId(
  message: { threadType: string | null; threadId: string | null },
  organizationId: string,
  executor: Executor = db,
): Promise<string | null> {
  if (message.threadType !== "group" || !message.threadId) return null
  const [chat] = await executor
    .select({ projectId: groupChats.projectId })
    .from(groupChats)
    .where(and(eq(groupChats.id, message.threadId), eq(groupChats.organizationId, organizationId)))
  return chat?.projectId ?? null
}

const targetColumns = (target: LinkTarget) => ({
  messageId: target.messageId ?? null,
  taskId: target.taskId ?? null,
  commentId: target.commentId ?? null,
})

/** The target as a condition on `file_links l`, and a key naming it */
function targetMatch(target: LinkTarget): { on: SQL; key: string } {
  if (target.messageId) return { on: sql`l.message_id = ${target.messageId}::uuid`, key: `message:${target.messageId}` }
  if (target.taskId) return { on: sql`l.task_id = ${target.taskId}::uuid`, key: `task:${target.taskId}` }
  if (target.commentId) return { on: sql`l.comment_id = ${target.commentId}::uuid`, key: `comment:${target.commentId}` }
  throw new Error("A link needs a message, task or comment")
}

/**
 * Posts files where the actor may attach them, one link each. A draft stops being one, and posted inside a
 * project it becomes a project file. Files that are not allowed are skipped. Returns the ids now linked there.
 */
export async function linkFiles(
  target: LinkTarget,
  fileIds: string[],
  actor: { userId: string; organizationId: string },
  projectId: string | null,
  tx: Tx,
): Promise<string[]> {
  const linked: string[] = []
  const at = targetMatch(target)
  const columns = targetColumns(target)
  for (const fileId of new Set(fileIds)) {
    const loaded = await loadFileFacts(fileId, { ...actor, isOrgAdmin: false }, tx)
    if (!loaded || !canLinkInto({ projectId }, loaded.facts, loaded.viewer)) continue
    // The lock makes two posts of one file to one place take turns, so the second finds the first link
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`file-link:${fileId}:${at.key}`}, 0))`)
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into file_links (file_id, message_id, task_id, comment_id, organization_id, created_by)
      select ${fileId}::uuid, ${columns.messageId}::uuid, ${columns.taskId}::uuid, ${columns.commentId}::uuid,
        ${actor.organizationId}::uuid, ${actor.userId}::uuid
      where not exists (
        select 1 from file_links l
        where l.file_id = ${fileId}::uuid and ${at.on} and l.organization_id = ${actor.organizationId}::uuid
      )
      returning id`)
    if (inserted.length > 0 && loaded.file.isDraft) {
      const flipped = await tx
        .update(fileAttachments)
        .set({ isDraft: false, projectId, folderId: null, updatedAt: new Date().toISOString() })
        .where(
          and(eq(fileAttachments.id, fileId), eq(fileAttachments.isDraft, true), eq(fileAttachments.organizationId, actor.organizationId)),
        )
        .returning({ id: fileAttachments.id })
      // Another post took the draft first, so this one stands only if the file may still go here
      if (flipped.length === 0) {
        const now = await loadFileFacts(fileId, { ...actor, isOrgAdmin: false }, tx)
        if (!now || !canLinkInto({ projectId }, now.facts, now.viewer)) {
          await tx.delete(fileLinks).where(and(eq(fileLinks.id, inserted[0].id), eq(fileLinks.organizationId, actor.organizationId)))
          continue
        }
      }
    }
    linked.push(fileId)
  }
  return linked
}

/** Files that left Trash or went into it */
export type FileChange = { fileIds: string[]; removed: boolean }

/**
 * Tells every chat that links one of the files, and closes the live connections of docs that went to Trash or left it.
 * Call it only after the change has committed
 */
export async function emitFileChanged(change: FileChange, organizationId: string): Promise<void> {
  if (change.fileIds.length === 0) return
  // Trash makes a doc read only and a restore makes it writable again, so open tabs sign in again at the new level
  for (const fileId of change.fileIds) closeDocConnections({ fileId })
  if (change.removed) await closeTrashedShares(change.fileIds, organizationId)
  const rows = await db
    .select({
      fileId: fileLinks.fileId,
      senderId: messages.senderId,
      recipientId: messages.recipientId,
      threadType: messages.threadType,
      threadId: messages.threadId,
    })
    .from(fileLinks)
    .innerJoin(messages, eq(messages.id, fileLinks.messageId))
    .where(and(inArray(fileLinks.fileId, change.fileIds), eq(fileLinks.organizationId, organizationId)))
  const chats = new Map<string, { chat: () => Promise<ChatRef>; fileIds: Set<string> }>()
  for (const row of rows) {
    let key: string
    let chat: () => Promise<ChatRef>
    if (row.threadType === "group" && row.threadId) {
      const id = row.threadId
      key = `group:${id}`
      chat = async () => ({ kind: "group", id, memberIds: await groupMemberIds(id) })
    } else if (!row.threadType && row.recipientId) {
      const [a, b] = [row.senderId, row.recipientId].sort()
      key = `dm:${a}:${b}`
      chat = async () => ({ kind: "dm", a, b })
    } else continue
    const entry = chats.get(key) ?? { chat, fileIds: new Set<string>() }
    entry.fileIds.add(row.fileId)
    chats.set(key, entry)
  }
  for (const entry of chats.values()) {
    const chat = await entry.chat()
    for (const fileId of entry.fileIds) {
      emitToChat(organizationId, chat, "file:changed", { fileId, removed: change.removed })
    }
  }
}

/**
 * Runs a Trash change in the caller's transaction, when given, and leaves telling the chats to the caller after
 * its commit. Otherwise it runs in its own transaction and tells them once that has committed
 */
async function trashChange<T extends FileChange | Refused>(
  tx: Tx | undefined,
  organizationId: string,
  run: (tx: Tx) => Promise<T | null>,
): Promise<T | null> {
  if (tx) return run(tx)
  const change = await db.transaction(run)
  if (change && "fileIds" in change) await emitFileChanged(change, organizationId)
  return change
}

export type Refused = { refused: string }

/**
 * The refusal for an item whose project is in Trash, when the actor could restore it once the project is back. The
 * project role is read from the membership, since a project in Trash gives nobody access
 */
async function projectInTrash(
  loaded: { facts: FileFacts; viewer: ViewerFacts },
  actor: FileActor,
  executor: Executor,
  adminOnly: boolean,
): Promise<Refused | null> {
  const { projectId } = loaded.facts
  if (!projectId) return null
  // trash: a restore refuses while the project is in Trash, so it reads the project either way, held so a project trash waits
  const [project] = await executor
    .select({ name: projects.name, deletedAt: projects.deletedAt, createdBy: projects.createdBy })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, actor.organizationId)))
    .for("share")
  const refused = project ? restoreBlock(project) : null
  if (!refused) return null
  // tenancy: the project was just read inside the workspace
  const [membership] = await executor
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, actor.userId)))
    .orderBy(asc(projectMembers.role))
  const projectRole = !membership ? null : membership.role === "admin" || project.createdBy === actor.userId ? "admin" : "member"
  if (adminOnly && projectRole !== "admin") return null
  return can("restore", loaded.facts, { ...loaded.viewer, projectRole }) ? { refused } : null
}

type TrashOptions = { tx?: Tx; via?: Via | null }

/** Moves a file to Trash when the actor may. Null when refused */
export function trashFile(fileId: string, actor: FileActor, { tx, via = null }: TrashOptions = {}): Promise<FileChange | null> {
  return trashChange(tx, actor.organizationId, async (t) => {
    const loaded = await loadFileFacts(fileId, viewerOf(actor), t)
    if (!loaded || !can("trash", loaded.facts, loaded.viewer)) return null
    const trashed = await t
      .update(fileAttachments)
      .set({ deletedAt: new Date().toISOString(), trashRoot: fileId, deletedBy: actor.userId, deletedVia: via })
      .where(
        and(eq(fileAttachments.id, fileId), isNull(fileAttachments.deletedAt), eq(fileAttachments.organizationId, actor.organizationId)),
      )
      .returning({ id: fileAttachments.id })
    return trashed.length > 0 ? { fileIds: trashed.map((row) => row.id), removed: true } : null
  })
}

/** Brings back every row the root's deletion trashed. A root whose folder is still in Trash lands at the top */
async function restoreRoot(rootId: string, organizationId: string, tx: Tx): Promise<FileChange> {
  const files = await tx
    .update(fileAttachments)
    .set({ deletedAt: null, trashRoot: null, deletedBy: null, deletedVia: null })
    .where(and(eq(fileAttachments.trashRoot, rootId), eq(fileAttachments.organizationId, organizationId)))
    .returning({ id: fileAttachments.id })
  await tx
    .update(fileFolders)
    .set({ deletedAt: null, trashRoot: null, deletedBy: null, deletedVia: null })
    .where(and(eq(fileFolders.trashRoot, rootId), eq(fileFolders.organizationId, organizationId)))
  const trashedFolders = tx
    .select({ id: fileFolders.id })
    .from(fileFolders)
    .where(and(isNotNull(fileFolders.deletedAt), eq(fileFolders.organizationId, organizationId)))
  await tx
    .update(fileAttachments)
    .set({ folderId: null })
    .where(
      and(
        eq(fileAttachments.id, rootId),
        eq(fileAttachments.organizationId, organizationId),
        inArray(fileAttachments.folderId, trashedFolders),
      ),
    )
  await tx
    .update(fileFolders)
    .set({ parentFolderId: null })
    .where(
      and(eq(fileFolders.id, rootId), eq(fileFolders.organizationId, organizationId), inArray(fileFolders.parentFolderId, trashedFolders)),
    )
  return { fileIds: files.map((row) => row.id), removed: false }
}

/**
 * Takes a file out of Trash when the actor may. Trash lists only roots, so a file trashed with its folder is
 * refused like an id nobody has, and comes back with the folder. Null when refused
 */
export function restoreFile(fileId: string, actor: FileActor, tx?: Tx): Promise<FileChange | Refused | null> {
  const { organizationId } = actor
  return trashChange<FileChange | Refused>(tx, organizationId, async (t) => {
    const loaded = await loadFileFacts(fileId, viewerOf(actor), t)
    if (!loaded) return null
    if (loaded.file.deletedAt) {
      const blocked = await projectInTrash(loaded, actor, t, false)
      if (blocked) return blocked
    }
    if (!can("restore", loaded.facts, loaded.viewer)) return null
    const { file } = loaded
    if (file.trashRoot && file.trashRoot !== file.id) return null
    if (!file.trashRoot) {
      await t
        .update(fileAttachments)
        .set({ trashRoot: file.id })
        .where(and(eq(fileAttachments.id, file.id), eq(fileAttachments.organizationId, organizationId)))
    }
    return restoreRoot(file.id, organizationId, t)
  })
}

export type FolderRow = typeof fileFolders.$inferSelect

/** A folder against the same rules as a file, owned by whoever made it */
export async function folderFacts(
  folderId: string,
  actor: FileActor,
  executor: Executor,
): Promise<{ folder: FolderRow; facts: FileFacts; viewer: ViewerFacts } | null> {
  const viewer = viewerOf(actor)
  const [folder] = await executor
    .select()
    .from(fileFolders)
    .where(and(eq(fileFolders.id, folderId), eq(fileFolders.organizationId, viewer.organizationId)))
  if (!folder) return null
  return {
    folder,
    facts: {
      organizationId: folder.organizationId,
      ownerId: folder.createdBy,
      ownerRemovedAt: null,
      projectId: folder.projectId,
      kind: "file",
      isDraft: false,
      deletedAt: folder.deletedAt,
    },
    viewer: {
      ...viewer,
      projectRole: folder.projectId ? await projectRoleOf(viewer, folder.projectId, executor) : null,
      seesALink: false,
      hasGrant: false,
    },
  }
}

/**
 * Moves a folder to Trash with everything under it that is not there yet. A project folder may hold other
 * users' files, so only a project admin may trash one. Null when refused
 */
export function trashFolder(folderId: string, actor: FileActor, { tx, via = null }: TrashOptions = {}): Promise<FileChange | null> {
  const { organizationId } = actor
  return trashChange(tx, organizationId, async (t) => {
    const loaded = await folderFacts(folderId, actor, t)
    if (!loaded || !can("trash", loaded.facts, loaded.viewer)) return null
    if (loaded.folder.projectId && loaded.viewer.projectRole !== "admin") return null
    const tree = await folderTree(folderId, organizationId, t)
    const now = new Date().toISOString()
    await t
      .update(fileFolders)
      .set({ deletedAt: now, trashRoot: folderId, deletedBy: actor.userId, deletedVia: via })
      .where(and(inArray(fileFolders.id, tree), isNull(fileFolders.deletedAt), eq(fileFolders.organizationId, organizationId)))
    const files = await t
      .update(fileAttachments)
      .set({ deletedAt: now, trashRoot: folderId, deletedBy: actor.userId, deletedVia: via })
      .where(
        and(inArray(fileAttachments.folderId, tree), isNull(fileAttachments.deletedAt), eq(fileAttachments.organizationId, organizationId)),
      )
      .returning({ id: fileAttachments.id })
    return { fileIds: files.map((row) => row.id), removed: true }
  })
}

/**
 * Takes a trashed folder out of Trash with everything its deletion took. Only a root can be restored, and a
 * project folder only by a project admin, as with trashing it. Null when refused
 */
export function restoreFolder(folderId: string, actor: FileActor, tx?: Tx): Promise<FileChange | Refused | null> {
  return trashChange<FileChange | Refused>(tx, actor.organizationId, async (t) => {
    const loaded = await folderFacts(folderId, actor, t)
    if (!loaded) return null
    if (loaded.folder.deletedAt) {
      const blocked = await projectInTrash(loaded, actor, t, true)
      if (blocked) return blocked
    }
    if (loaded.folder.trashRoot !== folderId || !can("restore", loaded.facts, loaded.viewer)) return null
    if (loaded.folder.projectId && loaded.viewer.projectRole !== "admin") return null
    return restoreRoot(folderId, actor.organizationId, t)
  })
}

/**
 * What a purge was decided on. The delete checks it in the same statement, so a file posted, restored or put
 * back as an avatar meanwhile survives
 * - `draft`: still an unposted draft, outside Trash
 * - `trashed`: still in Trash, and for the cleanup trashed before the cutoff
 * - `any`: the caller's own condition, such as an admin delete in its workspace
 */
export type PurgeGuard =
  | { expect: "draft"; ownerId?: string; organizationId?: string; createdBefore?: SQL }
  | { expect: "trashed"; organizationId?: string; trashRoot?: string; ownRoot?: boolean; trashedBefore?: SQL }
  | { expect: "any"; organizationId?: string; condition?: SQL }

function guardCondition(guard: PurgeGuard): SQL {
  const parts: SQL[] = []
  if (guard.organizationId) parts.push(sql`f.organization_id = ${guard.organizationId}::uuid`)
  if (guard.expect === "draft") {
    parts.push(sql`f.is_draft and f.deleted_at is null`)
    if (guard.ownerId) parts.push(sql`f.uploaded_by = ${guard.ownerId}::uuid`)
    if (guard.createdBefore) parts.push(sql`f.created_at <= ${guard.createdBefore}`)
  } else if (guard.expect === "trashed") {
    parts.push(sql`f.deleted_at is not null`)
    if (guard.trashRoot) parts.push(sql`f.trash_root = ${guard.trashRoot}::uuid`)
    // Trashed on its own, so not a file restored and then trashed again with its folder
    if (guard.ownRoot) parts.push(sql`(f.trash_root = f.id or f.trash_root is null)`)
    if (guard.trashedBefore) parts.push(sql`f.deleted_at <= ${guard.trashedBefore}`)
  } else if (guard.condition) {
    parts.push(guard.condition)
  }
  return parts.length ? sql` and ${sql.join(parts, sql` and `)}` : sql``
}

/**
 * Deletes the record when it still matches the guard, and adds the delete of its stored object in the same
 * transaction. A paper or board has none of its own, and its images go with it. True when the record went
 */
export async function purgeFile(fileId: string, guard: PurgeGuard, executor: Executor = db): Promise<boolean> {
  return executor.transaction(async (tx) => {
    const paths = await purgeFileRows(fileId, guard, tx)
    if (!paths) return false
    await dropStoredObjects(tx, paths)
    return true
  })
}

/**
 * Deletes the record and its doc's images when it still matches the guard, and answers the stored objects they leave.
 * Null when the record didn't go. Pass the objects to `dropStoredObjects` in the same transaction
 */
export async function purgeFileRows(fileId: string, guard: PurgeGuard, executor: Executor = db): Promise<string[] | null> {
  // tenancy: callers pass an id they resolved inside the workspace, and the guard names it, or the cleanup job across all
  const rows = await executor.execute<{ file_path: string; main: boolean }>(sql`
    with gone as (
      delete from file_attachments f
      where f.id = ${fileId}::uuid${guardCondition(guard)}
      returning f.id, f.file_path, f.organization_id),
    images as (
      delete from file_attachments i using gone
      where i.doc_file_id = gone.id and i.organization_id is not distinct from gone.organization_id
      returning i.file_path)
    select file_path, true as main from gone
    union all select file_path, false as main from images`)
  if (!rows.some((row) => row.main)) return null
  return rows.map((row) => row.file_path).filter((path) => !isDocPath(path))
}

/**
 * Adds a retried delete for each stored object. Inside the transaction that deletes their records, so the objects go
 * only once the records are gone for good, and still go when storage fails or the server stops meanwhile
 */
export async function dropStoredObjects(executor: Executor, paths: string[]): Promise<void> {
  for (const path of paths) await addJob(executor, "storage.delete", { path }, { uniqueKey: `storage:${path}` })
}

defineJob<{ path: string }>("storage.delete", {}, ({ path }) => deleteObject(path))

/** Loads each link's file with what its attachment needs, oldest link first */
export const LINKED_FILES = {
  with: { file: { with: { uploader: { columns: { removedAt: true } } } } },
  orderBy: [asc(fileLinks.createdAt), asc(fileLinks.id)] as SQL[],
} as const

type LinkedFile = FileRow & { uploader?: { removedAt: string | null } | null }

/**
 * A file as posted somewhere, in the attachment shape the website reads. `created_at` is when it was posted
 * there. A file in Trash, or past its removed owner's deadline, shows only that it was removed
 */
export function attachmentDto(file: LinkedFile, link: { createdAt: string }) {
  const removedAt = file.projectId ? null : (file.uploader?.removedAt ?? null)
  const deadline = removedAt ? removalDeadline(removedAt) : null
  if (file.deletedAt || (deadline && Date.now() >= Date.parse(deadline))) {
    return { id: file.id, removed: true as const }
  }
  return {
    id: file.id,
    file_name: file.fileName,
    file_size: file.fileSize,
    mime_type: file.mimeType,
    created_at: link.createdAt,
    alt_text: file.altText,
    removed: false as const,
    removal_deadline: deadline,
    uploaded_by: file.uploadedBy,
  }
}

export type AttachmentDto = ReturnType<typeof attachmentDto>

export const linkAttachments = (links: { createdAt: string; file: LinkedFile }[]): AttachmentDto[] =>
  links.map((link) => attachmentDto(link.file, link))
