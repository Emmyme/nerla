export type TaskStatus = "backlog" | "todo" | "in_progress" | "done"
export type TaskPriority = "none" | "low" | "medium" | "high" | "urgent"

export const TASK_DESCRIPTION_MAX = 100_000

export const TASK_STATUSES: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "done"]
export const ACTIVE_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter((status) => status !== "backlog")
export const TASK_PRIORITIES: readonly TaskPriority[] = ["urgent", "high", "medium", "low", "none"]

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
}

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
}
