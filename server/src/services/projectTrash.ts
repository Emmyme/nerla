import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm"
import {
  db,
  fileAttachments,
  fileFolders,
  fileShareLinks,
  groupChats,
  notifications,
  projectMembers,
  projects,
  taskComments,
  tasks,
  type Executor,
  type Tx,
} from "../db"
import type { Via } from "../utils/aiTypes"
import { logger } from "../utils/logger"
import { liveProject, liveTask, projectTrashRights, type TrashRights } from "../utils/trash"
import { chatsChanged, deleteGroupChats, groupMemberIds } from "./chats"
import { dropStoredObjects, emitFileChanged, purgeFileRows } from "./files"
import { announceRemoved, removedByUser } from "./notifications"
import { detachTimeEntries } from "./timeDetach"
import { pushTimersGone, stopProjectTimers, timingPeople } from "./timeEntries"
import { errorText } from "../utils/errorText"

type ProjectTrashActor = { userId: string; organizationId: string; isOrgAdmin: boolean }

/** The project row, in Trash or live, taken for update so a trash, a restore and a purge take turns */
async function lockedProject(tx: Tx, projectId: string, organizationId: string, state: "trashed" | "live") {
  // trash: a restore and a purge read the project in Trash
  const [project] = await tx
    .select({ id: projects.id, slug: projects.slug, deletedAt: projects.deletedAt })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        state === "trashed" ? isNotNull(projects.deletedAt) : liveProject,
      ),
    )
    .for("update")
  return project ?? null
}

async function rightsOn(executor: Executor, projectId: string, actor: ProjectTrashActor): Promise<TrashRights> {
  // tenancy: the project was just read inside the workspace
  const [membership] = await executor
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, actor.userId)))
    .orderBy(asc(projectMembers.role))
  const projectRole = membership ? (membership.role === "admin" ? "admin" : "member") : null
  return projectTrashRights({ projectRole, isOrgAdmin: actor.isOrgAdmin })
}

const chatOf = async (executor: Executor, projectId: string, organizationId: string) =>
  (
    await executor
      .select({ id: groupChats.id })
      .from(groupChats)
      .where(and(eq(groupChats.projectId, projectId), eq(groupChats.organizationId, organizationId)))
  ).map((row) => row.id)

/** What follows a saved change only tells users, so a failure there is logged and never undoes the answer */
async function afterSave(step: "trash" | "restore" | "purge", run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    logger.warn("A project change saved but telling people failed", {
      step,
      error: errorText(error),
    })
  }
}

async function tellChats(organizationId: string, chatIds: string[]): Promise<void> {
  for (const chatId of chatIds) chatsChanged(organizationId, await groupMemberIds(chatId))
}

/** Removes the notifications of the project, its tasks and their comments, its files and its chat */
async function dropProjectNotifications(
  tx: Tx,
  organizationId: string,
  projectId: string,
  taskIds: string[],
  fileIds: string[],
  chatIds: string[],
): Promise<Map<string, string[]>> {
  const comments = tx
    .select({ id: taskComments.id })
    .from(taskComments)
    .where(and(inArray(taskComments.taskId, taskIds), eq(taskComments.organizationId, organizationId)))
  const gone = await tx
    .delete(notifications)
    .where(
      and(
        eq(notifications.organizationId, organizationId),
        or(
          eq(notifications.projectId, projectId),
          inArray(notifications.taskId, taskIds),
          inArray(notifications.commentId, comments),
          inArray(notifications.fileId, fileIds),
          and(eq(notifications.chatKind, "group"), inArray(notifications.chatId, chatIds)),
        ),
      ),
    )
    .returning({ id: notifications.id, userId: notifications.userId })
  return removedByUser(gone)
}

/**
 * Moves a project to Trash with every task, file, paper, board and folder of it not there yet, all stamped with the
 * project's id as `trash_root`. Members, the chat, pins, the key and the slug stay. Locks are taken in the order a
 * task trash takes them: the project, then its tasks. Running timers stop after the commit, since each stop takes its
 * user's lock and a user stopping their own timer holds that lock while waiting on the project
 */
export async function trashProject(projectId: string, actor: ProjectTrashActor, via: Via | null): Promise<{ id: string } | null> {
  const { organizationId } = actor
  const done = await db.transaction(async (tx) => {
    const project = await lockedProject(tx, projectId, organizationId, "live")
    if (!project || !(await rightsOn(tx, projectId, actor)).restore) return null
    const projectTasks = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.organizationId, organizationId), liveTask))
      .orderBy(asc(tasks.id))
      .for("no key update")
    const stamp = { deletedAt: new Date().toISOString(), deletedBy: actor.userId, deletedVia: via }
    await tx
      .update(projects)
      .set(stamp)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
    const taskIds = projectTasks.map((row) => row.id)
    await tx
      .update(tasks)
      .set({ ...stamp, trashRoot: projectId })
      .where(and(inArray(tasks.id, taskIds), eq(tasks.organizationId, organizationId), liveTask))
    // A doc's images stay with their doc and go only with it
    const files = await tx
      .update(fileAttachments)
      .set({ ...stamp, trashRoot: projectId })
      .where(
        and(
          eq(fileAttachments.projectId, projectId),
          eq(fileAttachments.organizationId, organizationId),
          isNull(fileAttachments.deletedAt),
          ne(fileAttachments.kind, "docimage"),
        ),
      )
      .returning({ id: fileAttachments.id })
    const folders = await tx
      .update(fileFolders)
      .set({ ...stamp, trashRoot: projectId })
      .where(and(eq(fileFolders.projectId, projectId), eq(fileFolders.organizationId, organizationId), isNull(fileFolders.deletedAt)))
      .returning({ id: fileFolders.id })
    const fileIds = files.map((row) => row.id)
    const folderIds = folders.map((row) => row.id)
    // Outside links to its files and folders end with it, and a restore doesn't bring them back
    await tx
      .update(fileShareLinks)
      .set({ revokedAt: stamp.deletedAt })
      .where(
        and(
          eq(fileShareLinks.organizationId, organizationId),
          isNull(fileShareLinks.revokedAt),
          or(inArray(fileShareLinks.fileId, fileIds), inArray(fileShareLinks.folderId, folderIds)),
        ),
      )
    const chatIds = await chatOf(tx, projectId, organizationId)
    const removed = await dropProjectNotifications(tx, organizationId, projectId, taskIds, fileIds, chatIds)
    const timing = await timingPeople(tx, organizationId, { projectId })
    return { fileIds, chatIds, removed, timing }
  })
  if (!done) return null
  await afterSave("trash", async () => {
    await stopProjectTimers(organizationId, projectId, done.timing)
    void announceRemoved(organizationId, done.removed)
    await emitFileChanged({ fileIds: done.fileIds, removed: true }, organizationId)
    await tellChats(organizationId, done.chatIds)
  })
  return { id: projectId }
}

/**
 * Brings a project back from Trash with everything that went with it. What was trashed on its own before stays in
 * Trash. A project already back, which the actor may restore, counts as restored, so a second Undo is fine. Null when
 * it is out of the actor's sight or reach
 */
export async function restoreProject(projectId: string, actor: ProjectTrashActor): Promise<{ id: string; slug: string } | null> {
  const { organizationId } = actor
  const done = await db.transaction(async (tx) => {
    const project =
      (await lockedProject(tx, projectId, organizationId, "trashed")) ?? (await lockedProject(tx, projectId, organizationId, "live"))
    if (!project || !(await rightsOn(tx, projectId, actor)).restore) return null
    if (!project.deletedAt) return { project, fileIds: [], chatIds: [] }
    const back = { deletedAt: null, deletedBy: null, deletedVia: null, trashRoot: null }
    await tx
      .update(projects)
      .set({ deletedAt: null, deletedBy: null, deletedVia: null })
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
    await tx
      .update(tasks)
      .set(back)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.trashRoot, projectId), eq(tasks.organizationId, organizationId)))
    const files = await tx
      .update(fileAttachments)
      .set(back)
      .where(and(eq(fileAttachments.trashRoot, projectId), eq(fileAttachments.organizationId, organizationId)))
      .returning({ id: fileAttachments.id })
    await tx
      .update(fileFolders)
      .set(back)
      .where(and(eq(fileFolders.trashRoot, projectId), eq(fileFolders.organizationId, organizationId)))
    return { project, fileIds: files.map((row) => row.id), chatIds: await chatOf(tx, projectId, organizationId) }
  })
  if (!done) return null
  await afterSave("restore", async () => {
    await emitFileChanged({ fileIds: done.fileIds, removed: false }, organizationId)
    await tellChats(organizationId, done.chatIds)
  })
  return { id: done.project.id, slug: done.project.slug }
}

/** What the actor may do with a project in Trash. Null when it is not there or out of the actor's sight */
export async function projectTrashAccess(projectId: string, actor: ProjectTrashActor): Promise<TrashRights | null> {
  // trash: Trash reads the project in Trash
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, actor.organizationId), isNotNull(projects.deletedAt)))
  if (!project) return null
  const rights = await rightsOn(db, projectId, actor)
  return rights.see ? rights : null
}

/**
 * Deletes a project for good, only while it is still in Trash and, when given, past the cutoff. Its files and folders are purged, its chat goes, its time is detached with the names kept on
 * locked time, then the row takes its tasks, members and pins with it. Stored objects are dropped after the commit
 */
export async function purgeProject(
  projectId: string,
  organizationId: string,
  guard: { trashedBefore?: string; actor?: ProjectTrashActor },
): Promise<boolean> {
  const done = await db.transaction(async (tx) => {
    // trash: the purge reads the project in Trash
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          isNotNull(projects.deletedAt),
          guard.trashedBefore ? lt(projects.deletedAt, guard.trashedBefore) : undefined,
        ),
      )
      .for("update")
    if (!project || (guard.actor && !(await rightsOn(tx, projectId, guard.actor)).purge)) return null
    const files = await tx
      .select({ id: fileAttachments.id })
      .from(fileAttachments)
      .where(and(eq(fileAttachments.projectId, projectId), eq(fileAttachments.organizationId, organizationId)))
      .orderBy(asc(fileAttachments.id))
    for (const file of files) await dropStoredObjects(tx, (await purgeFileRows(file.id, { expect: "any", organizationId }, tx)) ?? [])
    await tx.delete(fileFolders).where(and(eq(fileFolders.projectId, projectId), eq(fileFolders.organizationId, organizationId)))
    const formerMembers = await deleteGroupChats(await chatOf(tx, projectId, organizationId), tx)
    const timers = await detachTimeEntries(tx, organizationId, { projectId })
    await tx
      .delete(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId), isNotNull(projects.deletedAt)))
    return { formerMembers, timers }
  })
  if (!done) return false
  await afterSave("purge", async () => {
    chatsChanged(organizationId, done.formerMembers)
    pushTimersGone(organizationId, done.timers)
  })
  return true
}
