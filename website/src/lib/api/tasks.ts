import { toDueDateValue } from "@/lib/dates"
import type { TaskPriority, TaskStatus } from "@/types/tasks"
import { get, post, put, del } from "@/lib/api/request"
import type { UserSummary } from "@/lib/api/users"
import type { Attachment } from "@/lib/api/files"
import type { TrashRef } from "@/lib/api/trash"
import type { Via } from "@/lib/api/ai"

export interface TaskComment {
  id: string
  task_id: string
  user_id: string
  content: string
  /** Made through the user's agent or AI */
  done_via?: Via | null
  created_at: string
  updated_at: string
  user: {
    id: string
    email: string
    first_name: string
    last_name: string
    avatar_url: string | null
  } | null
  attachments: Attachment[]
}

export interface TaskProjectRef {
  id: string
  name: string
  slug: string
  key: string | null
  color: string | null
  icon?: string | null
}

export interface Task {
  id: string
  identifier: string | null
  number: number | null
  project_id: string | null
  project: TaskProjectRef | null
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  assigned_to: string | null
  assignee: UserSummary | null
  created_by: string | null
  position: number | null
  due_date: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
  attachments: Attachment[]
  /** Made through the user's agent or AI */
  done_via?: Via | null
}

export type TaskPatch = Partial<Pick<Task, "title" | "description" | "status" | "priority" | "assigned_to" | "due_date" | "project_id">>

/** `title` and `description` rows hold the full old and new text, kept only for edits by an agent or the AI. `trash` rows say "trashed" or "restored" */
export type TaskActivityField = "status" | "priority" | "assignee" | "due_date" | "project" | "title" | "description" | "trash"

export interface TaskActivity {
  id: string
  field: TaskActivityField
  from_value: string | null
  to_value: string | null
  from_label: string | null
  to_label: string | null
  created_at: string
  user: UserSummary | null
  /** Made through the user's agent or AI */
  done_via?: Via | null
}

const CLEARED_BY_EMPTY_STRING = ["description", "assigned_to"] as const

function toTaskBody(patch: TaskPatch): Record<string, unknown> {
  const body: Record<string, unknown> = { ...patch }
  for (const field of CLEARED_BY_EMPTY_STRING) {
    if (patch[field] === null) body[field] = ""
  }
  if (patch.due_date !== undefined) body.due_date = toDueDateValue(patch.due_date) ?? ""
  return body
}

export const tasksAPI = {
  getUserTasks: async (): Promise<Task[]> => {
    return get("/tasks/user")
  },

  getTask: async (taskId: string, signal?: AbortSignal): Promise<Task> => {
    return get(`/tasks/${taskId}`, { signal })
  },

  getProjectTasks: async (projectId: string): Promise<Task[]> => {
    return get(`/tasks/project/${projectId}`)
  },

  createTask: async (input: {
    title: string
    description?: string
    project_id?: string | null
    assigned_to?: string | null
    status?: TaskStatus
    priority?: TaskPriority
    due_date?: string
  }): Promise<Task> => {
    return post("/tasks", { ...input, due_date: toDueDateValue(input.due_date) ?? undefined })
  },

  /** A move out of a project says how many of that project's files stayed behind, unlinked from the task */
  updateTask: async (taskId: string, patch: TaskPatch): Promise<Task & { unlinkedFiles?: number }> => {
    return put(`/tasks/${taskId}`, toTaskBody(patch))
  },

  deleteTask: (taskId: string): Promise<TrashRef> => del<{ trash: TrashRef }>(`/tasks/${taskId}`).then((reply) => reply.trash),

  /** A task whose project is in Trash is refused with words to show */
  restoreTask: (taskId: string): Promise<Task> => post(`/tasks/${taskId}/restore`),

  purgeTask: (taskId: string): Promise<void> => del(`/tasks/${taskId}/forever`),

  getTaskActivity: async (taskId: string, signal?: AbortSignal): Promise<TaskActivity[]> => {
    return get(`/tasks/${taskId}/activity`, { signal })
  },

  getTaskComments: async (taskId: string, signal?: AbortSignal): Promise<TaskComment[]> => {
    return get(`/tasks/${taskId}/comments`, { signal })
  },

  createTaskComment: async (taskId: string, content: string, fileIds?: string[]): Promise<TaskComment> => {
    return post(`/tasks/${taskId}/comments`, { content, fileIds })
  },

  updateTaskComment: async (commentId: string, content: string): Promise<TaskComment> => {
    return put(`/tasks/comments/${commentId}`, { content })
  },

  deleteTaskComment: async (commentId: string): Promise<void> => {
    await del(`/tasks/comments/${commentId}`)
  },

  /** At most 100 ids, in the order asked. A task the caller can't reach comes back hidden */
  summaries: (ids: string[], signal?: AbortSignal): Promise<TaskSummary[]> =>
    get(`/tasks/summaries?ids=${ids.map(encodeURIComponent).join(",")}`, { signal }),
}

export type TaskSummary =
  | {
      id: string
      hidden?: false
      identifier: string | null
      title: string
      status: TaskStatus
      assignee: { id: string; name: string; avatarUrl: string | null } | null
    }
  | { id: string; hidden: true }
