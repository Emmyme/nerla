import { get, queryOf } from "@/lib/api/request"
import { type Task, tasksAPI } from "@/lib/api/tasks"
import { fileBrowserAPI } from "@/lib/api/files"
import { type Project, projectsAPI } from "@/lib/api/projects"
import { type CalendarEvent, calendarAPI } from "@/lib/api/calendar"
import type { Via } from "@/lib/api/ai"

export type TrashKind = "file" | "folder" | "paper" | "board" | "task" | "event" | "project"

/** What a delete made, so Undo restores exactly that entry */
export type TrashRef = { kind: TrashKind; id: string }

/** One Trash entry. `where` is always "own" for events and projects */
export interface TrashItem {
  kind: TrashKind
  id: string
  name: string
  detail: string | null
  where: { kind: "project" | "folder" | "own"; name: string | null }
  /** A file's or folder's project, and its parent folder while that is not in Trash */
  projectId?: string | null
  folderId?: string | null
  /** A project's tile */
  color?: string | null
  icon?: string | null
  /** The words a restore would be refused with now */
  blocked: string | null
  deletedAt: string
  deletedBy: { id: string; name: string } | null
  deletedVia: Via | null
  purgeAt: string
  can: { restore: boolean; purge: boolean }
}

export type TrashFilterKey = "all" | "files" | "docs" | "tasks" | "events" | "projects"

/** What a restore answers: the task, event or project back, or nothing for a file */
export type Restored =
  | { kind: "task"; task: Task }
  | { kind: "event"; event: CalendarEvent | { id: string } }
  | { kind: "project"; project: Project }
  | { kind: "file" }

export const trashAPI = {
  /** Newest deleted first, 50 a page */
  list: (kind: TrashFilterKey, cursor?: string | null, signal?: AbortSignal): Promise<{ items: TrashItem[]; nextCursor: string | null }> =>
    get(`/trash?${queryOf({ kind, cursor })}`, { signal }),

  restore: async ({ kind, id }: TrashRef): Promise<Restored> => {
    if (kind === "task") return { kind, task: await tasksAPI.restoreTask(id) }
    if (kind === "event") return { kind, event: await calendarAPI.restoreEvent(id) }
    if (kind === "project") return { kind, project: await projectsAPI.restoreProject(id) }
    await (kind === "folder" ? fileBrowserAPI.restoreFolder(id) : fileBrowserAPI.restoreFile(id))
    return { kind: "file" }
  },

  purge: ({ kind, id }: TrashRef): Promise<void> => {
    if (kind === "task") return tasksAPI.purgeTask(id)
    if (kind === "event") return calendarAPI.purgeEvent(id)
    if (kind === "project") return projectsAPI.purgeProject(id)
    return kind === "folder" ? fileBrowserAPI.purgeFolder(id) : fileBrowserAPI.purgeFile(id)
  },
}
