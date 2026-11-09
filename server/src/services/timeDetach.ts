import { and, asc, eq, inArray, isNotNull, lte, or, type SQL } from "drizzle-orm"
import { projects, tasks, timeEntries, timeTimers, type Tx } from "../db"
import { formatTaskIdentifier } from "../utils/taskKeys"

/** "WR-3 Fix the header", or the title alone for a task with no identifier */
async function taskLabels(tx: Tx, organizationId: string, taskIds: string[]): Promise<Map<string, string>> {
  if (!taskIds.length) return new Map()
  // trash: the purge detaches time from what is in Trash
  const rows = await tx
    .select({ id: tasks.id, title: tasks.title, number: tasks.number, key: projects.key })
    .from(tasks)
    .leftJoin(projects, and(eq(projects.id, tasks.projectId), eq(projects.organizationId, organizationId)))
    .where(and(inArray(tasks.id, taskIds), eq(tasks.organizationId, organizationId)))
  return new Map(
    rows.map((row) => {
      const identifier = formatTaskIdentifier(row.key, row.number)
      return [row.id, (identifier ? `${identifier} ${row.title}` : row.title).slice(0, 300)]
    }),
  )
}

/** The users whose running timer goes with the place. The caller holds its rows, so no timer starts there meanwhile */
async function timerUsers(tx: Tx, organizationId: string, on: SQL | undefined): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ userId: timeTimers.userId })
    .from(timeTimers)
    .where(and(eq(timeTimers.organizationId, organizationId), on))
  return rows.map((row) => row.userId)
}

/** Locked time on the task keeps its project and the task's name. The rest goes with the task */
async function detachTask(tx: Tx, organizationId: string, taskId: string): Promise<void> {
  // Holding the task row keeps new time off it until it is gone
  // trash: the purge detaches time from what is in Trash
  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId)))
    .for("update")
  if (!task) return
  const label = (await taskLabels(tx, organizationId, [taskId])).get(taskId) ?? null
  const onTask = tx
    .select({ projectId: timeEntries.projectId })
    .from(timeEntries)
    .where(and(eq(timeEntries.organizationId, organizationId), eq(timeEntries.taskId, taskId)))
  // trash: the purge detaches time from what is in Trash
  const locks = await tx
    .select({ id: projects.id, lockedUntil: projects.timeLockedUntil })
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), isNotNull(projects.timeLockedUntil), inArray(projects.id, onTask)))
    .orderBy(asc(projects.id))
    .for("share")
  const now = new Date().toISOString()
  for (const lock of locks) {
    await tx
      .update(timeEntries)
      .set({ taskId: null, taskLabel: label, updatedAt: now })
      .where(
        and(
          eq(timeEntries.organizationId, organizationId),
          eq(timeEntries.taskId, taskId),
          eq(timeEntries.projectId, lock.id),
          lte(timeEntries.date, lock.lockedUntil!),
        ),
      )
  }
  await tx.delete(timeEntries).where(and(eq(timeEntries.organizationId, organizationId), eq(timeEntries.taskId, taskId)))
}

/** Locked time on the project is kept, detached, with the project and task names saved on it. The rest goes */
async function detachProject(tx: Tx, organizationId: string, projectId: string): Promise<void> {
  // trash: the purge detaches time from what is in Trash
  const [project] = await tx
    .select({ id: projects.id, name: projects.name, lockedUntil: projects.timeLockedUntil })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
    .for("update")
  if (!project) return
  // Its tasks go with it, so new time on them waits for the delete
  // trash: the purge detaches time from what is in Trash
  const projectTasks = () =>
    tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.organizationId, organizationId)))
  await projectTasks().orderBy(asc(tasks.id)).for("update")
  if (project.lockedUntil) {
    const linked = await tx
      .selectDistinct({ taskId: timeEntries.taskId })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.organizationId, organizationId),
          eq(timeEntries.projectId, projectId),
          lte(timeEntries.date, project.lockedUntil),
          isNotNull(timeEntries.taskId),
        ),
      )
    const labels = await taskLabels(
      tx,
      organizationId,
      linked.map((row) => row.taskId!),
    )
    for (const [taskId, label] of labels) {
      await tx
        .update(timeEntries)
        .set({ taskLabel: label })
        .where(
          and(
            eq(timeEntries.organizationId, organizationId),
            eq(timeEntries.projectId, projectId),
            lte(timeEntries.date, project.lockedUntil),
            eq(timeEntries.taskId, taskId),
          ),
        )
    }
    const now = new Date().toISOString()
    await tx
      .update(timeEntries)
      .set({ projectId: null, taskId: null, projectName: project.name, detachedAt: now, updatedAt: now })
      .where(
        and(
          eq(timeEntries.organizationId, organizationId),
          eq(timeEntries.projectId, projectId),
          lte(timeEntries.date, project.lockedUntil),
        ),
      )
  }
  await tx.delete(timeEntries).where(and(eq(timeEntries.organizationId, organizationId), eq(timeEntries.projectId, projectId)))
  // Time logged on its tasks from another project, before a task moved here, follows the task
  const elsewhere = await tx
    .selectDistinct({ taskId: timeEntries.taskId })
    .from(timeEntries)
    .where(and(eq(timeEntries.organizationId, organizationId), inArray(timeEntries.taskId, projectTasks())))
  for (const row of elsewhere) await detachTask(tx, organizationId, row.taskId!)
}

/**
 * Runs inside the transaction that deletes a project or task, before the delete. Unlocked time on it goes, and locked
 * time stays with the names saved. It runs whether or not time tracking is on, so turning it on again shows no ghosts.
 * Running timers on the place go with it unlogged, and it answers whose, to tell them after the commit
 */
export async function detachTimeEntries(
  tx: Tx,
  organizationId: string,
  place: { projectId: string } | { taskId: string },
): Promise<string[]> {
  if ("taskId" in place) {
    await detachTask(tx, organizationId, place.taskId)
    return timerUsers(tx, organizationId, eq(timeTimers.taskId, place.taskId))
  }
  await detachProject(tx, organizationId, place.projectId)
  // trash: the purge detaches time from what is in Trash
  const projectTasks = tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.projectId, place.projectId), eq(tasks.organizationId, organizationId)))
  return timerUsers(tx, organizationId, or(eq(timeTimers.projectId, place.projectId), inArray(timeTimers.taskId, projectTasks)))
}
