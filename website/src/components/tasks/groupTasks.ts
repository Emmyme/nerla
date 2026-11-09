import type { Task } from "@/lib/api/tasks"
import type { UserSummary } from "@/lib/api/users"
import { toDueDateValue } from "@/lib/dates"
import { PRIORITY_LABEL, STATUS_LABEL, TASK_PRIORITIES, type TaskStatus } from "@/types/tasks"

export type TaskGroupBy = "status" | "priority" | "assignee" | "none"
export type TaskGroup = { key: string; label: string; tasks: Task[] }

const STATUS_GROUP_ORDER: readonly TaskStatus[] = ["in_progress", "todo", "backlog", "done"]
export const UNASSIGNED_KEY = "unassigned"

const PRIORITY_RANK = new Map(TASK_PRIORITIES.map((priority, rank) => [priority, rank]))

export function userName(user: UserSummary | null): string {
  if (!user) return "Unassigned"
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "Unknown user"
}

function compareTasks(a: Task, b: Task): number {
  const rank = (PRIORITY_RANK.get(a.priority) ?? PRIORITY_RANK.size) - (PRIORITY_RANK.get(b.priority) ?? PRIORITY_RANK.size)
  if (rank !== 0) return rank
  const dueA = toDueDateValue(a.due_date)
  const dueB = toDueDateValue(b.due_date)
  if (dueA === dueB) return 0
  if (dueA === null) return 1
  if (dueB === null) return -1
  return dueA < dueB ? -1 : 1
}

function bucket(tasks: Task[], keyOf: (task: Task) => string): Map<string, Task[]> {
  const buckets = new Map<string, Task[]>()
  for (const task of [...tasks].sort(compareTasks)) {
    const key = keyOf(task)
    const list = buckets.get(key)
    if (list) list.push(task)
    else buckets.set(key, [task])
  }
  return buckets
}

export function groupTasks(tasks: Task[], by: TaskGroupBy, statuses: readonly TaskStatus[] = STATUS_GROUP_ORDER): TaskGroup[] {
  if (by === "none") {
    return tasks.length > 0 ? [{ key: "all", label: "All tasks", tasks: [...tasks].sort(compareTasks) }] : []
  }

  if (by === "status") {
    const buckets = bucket(tasks, (task) => task.status)
    return STATUS_GROUP_ORDER.filter((status) => statuses.includes(status)).map((status) => ({
      key: status,
      label: STATUS_LABEL[status],
      tasks: buckets.get(status) ?? [],
    }))
  }

  if (by === "priority") {
    const buckets = bucket(tasks, (task) => task.priority)
    return TASK_PRIORITIES.filter((priority) => buckets.has(priority)).map((priority) => ({
      key: priority,
      label: PRIORITY_LABEL[priority],
      tasks: buckets.get(priority) ?? [],
    }))
  }

  const buckets = bucket(tasks, (task) => task.assignee?.id ?? UNASSIGNED_KEY)
  const groups = [...buckets].map(([key, list]) => ({ key, label: userName(list[0].assignee), tasks: list }))
  const unassigned = groups.filter((group) => group.key === UNASSIGNED_KEY)
  const assigned = groups
    .filter((group) => group.key !== UNASSIGNED_KEY)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }))
  return [...assigned, ...unassigned]
}
