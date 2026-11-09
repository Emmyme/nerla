import { isNull, sql, type SQL } from "drizzle-orm"
import { calendarEvents, projects, tasks } from "../db/schema"
import { serverInstant } from "./chatAccess"
import { DAY_MS } from "./eventTime"

export const TRASH_DAYS = 30

export type TrashKind = "file" | "folder" | "paper" | "board" | "task" | "event" | "project"

export const liveTask = isNull(tasks.deletedAt)
export const liveEvent = isNull(calendarEvents.deletedAt)
export const liveProject = isNull(projects.deletedAt)

/** The same rules for hand-written queries, where `alias` names the table in the query */
export const LIVE_TASK_SQL = (alias: string): SQL => sql`${sql.raw(alias)}.deleted_at is null`
export const LIVE_EVENT_SQL = (alias: string): SQL => sql`${sql.raw(alias)}.deleted_at is null`
export const LIVE_PROJECT_SQL = (alias: string): SQL => sql`${sql.raw(alias)}.deleted_at is null`

export function purgeAt(deletedAt: string): string {
  return new Date(serverInstant(deletedAt) + TRASH_DAYS * DAY_MS).toISOString()
}

export function daysLeft(deletedAt: string, now: Date): number {
  return Math.max(0, Math.ceil((serverInstant(purgeAt(deletedAt)) - now.getTime()) / DAY_MS))
}

export type TrashRights = { see: boolean; restore: boolean; purge: boolean }
type ProjectRole = "admin" | "member" | null

const rights = (see: boolean, purge = see): TrashRights => ({ see, restore: see, purge: see && purge })

/** A personal task is its assignee's. A project task is every member's, and only admins and its deleter purge it */
export function taskTrashRights(
  task: { projectId: string | null; assignedTo: string | null; deletedBy: string | null },
  viewer: { userId: string; projectRole: ProjectRole },
): TrashRights {
  if (!task.projectId) return rights(task.assignedTo === viewer.userId)
  return rights(viewer.projectRole !== null, viewer.projectRole === "admin" || task.deletedBy === viewer.userId)
}

/** An event is its organiser's, and the deleter's while they are still a workspace admin */
export function eventTrashRights(
  event: { createdBy: string; deletedBy: string | null },
  viewer: { userId: string; isOrgAdmin: boolean },
): TrashRights {
  return rights(event.createdBy === viewer.userId || (viewer.isOrgAdmin && event.deletedBy === viewer.userId))
}

export function projectTrashRights(viewer: { projectRole: ProjectRole; isOrgAdmin: boolean }): TrashRights {
  return rights(viewer.projectRole === "admin" || viewer.isOrgAdmin)
}

/**
 * Why an item can't come back while its project is in Trash. What went with the project, its `trash_root` the project's
 * id, comes back only with the project, so it is refused the same way
 */
export function restoreBlock(project: { name: string; deletedAt: string | null } | null): string | null {
  return project?.deletedAt ? `Restore the project ${project.name} first` : null
}
