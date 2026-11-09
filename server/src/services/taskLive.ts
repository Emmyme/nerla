import { and, eq } from "drizzle-orm"
import { db, projectMembers, projects, tasks } from "../db"
import { logger } from "../utils/logger"
import { sendToUser } from "./websocket"
import { errorText } from "../utils/errorText"

/** The project a task belongs to, trashed or not. Null for a personal task or one that is gone */
export async function projectOfTask(organizationId: string, taskId: string): Promise<string | null> {
  // trash: the project of a task in Trash still hears about it coming back or going for good
  const [row] = await db
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId)))
  return row?.projectId ?? null
}

/** Tells every member of these projects to reload their boards. A personal task has no project, so nobody else hears it */
export async function tasksChanged(organizationId: string, projectIds: (string | null | undefined)[]) {
  try {
    for (const projectId of new Set(projectIds)) {
      if (!projectId) continue
      // trash: a member of a project in Trash still hears of a task changing back or going for good
      const members = await db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(and(eq(projectMembers.projectId, projectId), eq(projects.organizationId, organizationId)))
      for (const { userId } of members) sendToUser(organizationId, userId, { type: "tasks-changed", projectId })
    }
  } catch (error) {
    logger.warn("Telling a project's members about a task change failed", { error: errorText(error) })
  }
}
