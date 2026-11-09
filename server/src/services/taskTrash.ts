import { and, eq, isNotNull, lt } from "drizzle-orm"
import { db, projectMembers, projects, taskActivity, tasks, type Executor, type Tx } from "../db"
import type { Via } from "../utils/aiTypes"
import { taskAccessLevel } from "../utils/taskAccess"
import { liveProject, liveTask, restoreBlock, taskTrashRights, type TrashRights } from "../utils/trash"
import { announceRemoved, dropNotifications } from "./notifications"
import { callerMembership } from "./projectAccess"
import { detachTimeEntries } from "./timeDetach"
import { announceStoppedTimers, lockTaskTimers, pushTimersGone, stopTaskTimers } from "./timeEntries"

type TrashActor = { userId: string; organizationId: string }

const trashRow = (tx: Tx, taskId: string, actor: TrashActor, to: "trashed" | "restored", via: Via | null) =>
  tx.insert(taskActivity).values({
    taskId,
    userId: actor.userId,
    organizationId: actor.organizationId,
    field: "trash",
    fromValue: null,
    toValue: to,
    doneVia: via,
  })

const lockProject = async (tx: Tx, projectId: string, organizationId: string) =>
  (
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId), liveProject))
      .for("share")
  ).length > 0

/**
 * Moves a task to Trash. The caller has checked member access with `loadWritableTask`, and it is checked again here
 * under the locks, taken in this order: the project, the users timing the task, then the task row
 */
export async function trashTask(taskId: string, actor: TrashActor, via: Via | null): Promise<{ id: string } | null> {
  const { organizationId } = actor
  const done = await db.transaction(async (tx) => {
    const placeOf = () =>
      tx
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId), liveTask))
    const [seen] = await placeOf()
    if (!seen || (seen.projectId && !(await lockProject(tx, seen.projectId, organizationId)))) return null
    const timing = await lockTaskTimers(tx, organizationId, taskId)
    const [locked] = await placeOf().for("update")
    if (!locked) return null
    if (locked.projectId && locked.projectId !== seen.projectId && !(await lockProject(tx, locked.projectId, organizationId))) return null
    const task = await tx.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId), liveTask),
      columns: { projectId: true, assignedTo: true, organizationId: true, deletedAt: true },
      with: { project: { columns: { organizationId: true, deletedAt: true }, with: callerMembership(actor.userId) } },
    })
    if (!task || taskAccessLevel(task, actor.userId, organizationId, false) !== "member") return null
    await tx
      .update(tasks)
      .set({ deletedAt: new Date().toISOString(), deletedBy: actor.userId, deletedVia: via, trashRoot: null })
      .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId)))
    const removed = await dropNotifications(tx, organizationId, { taskId })
    const stopped = await stopTaskTimers(tx, organizationId, taskId, timing)
    await trashRow(tx, taskId, actor, "trashed", via)
    return { removed, stopped }
  })
  if (!done) return null
  void announceRemoved(organizationId, done.removed)
  void announceStoppedTimers(organizationId, done.stopped)
  return { id: taskId }
}

type TrashedTask = {
  id: string
  projectId: string | null
  assignedTo: string | null
  deletedBy: string | null
  trashRoot: string | null
}

type ProjectRole = "admin" | "member" | null

type TrashedLookup = {
  task: TrashedTask
  project: { name: string; deletedAt: string | null } | null
  projectRole: ProjectRole
  rights: TrashRights
}

/** The task, in Trash or live, with what the actor may do with it, read under the project's share lock when asked */
async function taskWithRights(
  executor: Executor,
  taskId: string,
  actor: TrashActor,
  state: "trashed" | "live",
  lock = false,
): Promise<TrashedLookup | null> {
  const [task] = await executor
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      assignedTo: tasks.assignedTo,
      deletedBy: tasks.deletedBy,
      trashRoot: tasks.trashRoot,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.organizationId, actor.organizationId),
        state === "trashed" ? isNotNull(tasks.deletedAt) : liveTask,
      ),
    )
  if (!task) return null
  let project: TrashedLookup["project"] = null
  let projectRole: ProjectRole = null
  if (task.projectId) {
    // trash: a restore refuses while the project is in Trash, so it reads the project either way
    const found = executor
      .select({ name: projects.name, deletedAt: projects.deletedAt })
      .from(projects)
      .where(and(eq(projects.id, task.projectId), eq(projects.organizationId, actor.organizationId)))
    ;[project] = lock ? await found.for("share") : await found
    if (!project) return null
    // tenancy: the project was just read inside the workspace
    const [membership] = await executor
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, task.projectId), eq(projectMembers.userId, actor.userId)))
    projectRole = membership ? (membership.role === "admin" ? "admin" : "member") : null
  }
  const rights = taskTrashRights(task, { userId: actor.userId, projectRole })
  return rights.see ? { task, project, projectRole, rights } : null
}

/**
 * Brings a task back from Trash, or says why it can't come back yet. A task already back, which the actor may see,
 * counts as restored, so a second Undo is fine. Null when it is out of the actor's sight
 */
export async function restoreTask(
  taskId: string,
  actor: TrashActor,
  via: Via | null,
): Promise<{ id: string; projectId: string | null } | { refused: string } | null> {
  return db.transaction(async (tx) => {
    const found = await taskWithRights(tx, taskId, actor, "trashed", true)
    if (found) {
      const refused = restoreBlock(found.project)
      if (refused) return { refused }
      if (!found.rights.restore) return null
      const [restored] = await tx
        .update(tasks)
        .set({ deletedAt: null, deletedBy: null, deletedVia: null })
        .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, actor.organizationId), isNotNull(tasks.deletedAt)))
        .returning({ id: tasks.id, projectId: tasks.projectId })
      if (restored) {
        await trashRow(tx, taskId, actor, "restored", via)
        return restored
      }
    }
    const live = await taskWithRights(tx, taskId, actor, "live")
    return live ? { id: live.task.id, projectId: live.task.projectId } : null
  })
}

type PurgeCheck = (task: TrashedTask) => boolean

/**
 * What the actor may do with a task in Trash, and the purge rule to check again under the row lock. A task that went
 * with its project is only part of the project's entry
 */
export async function taskTrashAccess(taskId: string, actor: TrashActor): Promise<{ rights: TrashRights; allowed: PurgeCheck } | null> {
  const found = await taskWithRights(db, taskId, actor, "trashed")
  if (!found || found.task.trashRoot) return null
  const { projectRole } = found
  return {
    rights: found.rights,
    allowed: (task) => !task.trashRoot && taskTrashRights(task, { userId: actor.userId, projectRole }).purge,
  }
}

/** Deletes a task for good, only while it is still in Trash and, when given, past the cutoff */
export async function purgeTask(
  taskId: string,
  organizationId: string,
  guard: { trashedBefore?: string; allowed?: PurgeCheck },
): Promise<boolean> {
  const done = await db.transaction(async (tx) => {
    // The project is held before the task, in the order a project purge takes them
    const [place] = await tx
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId), isNotNull(tasks.deletedAt)))
    if (place?.projectId) {
      // trash: a purge holds the project whether or not it is in Trash
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, place.projectId), eq(projects.organizationId, organizationId)))
        .for("share")
    }
    const [task] = await tx
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        assignedTo: tasks.assignedTo,
        deletedBy: tasks.deletedBy,
        trashRoot: tasks.trashRoot,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.organizationId, organizationId),
          isNotNull(tasks.deletedAt),
          guard.trashedBefore ? lt(tasks.deletedAt, guard.trashedBefore) : undefined,
        ),
      )
      .for("update")
    if (!task || (guard.allowed && !guard.allowed(task))) return null
    const removed = await dropNotifications(tx, organizationId, { taskId })
    const timers = await detachTimeEntries(tx, organizationId, { taskId })
    await tx.delete(tasks).where(and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId), isNotNull(tasks.deletedAt)))
    return { removed, timers }
  })
  if (!done) return false
  void announceRemoved(organizationId, done.removed)
  pushTimersGone(organizationId, done.timers)
  return true
}
