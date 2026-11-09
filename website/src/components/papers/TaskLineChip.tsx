import { useEffect, useSyncExternalStore } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { Lock } from "@/components/icons"
import { StatusIcon } from "@/components/ui/status-icon"
import { avatarOf, UserAvatar } from "@/components/ui/user-avatar"
import { tasksAPI } from "@/lib/api/tasks"
import { cn } from "@/lib/utils"
import type { TaskSummaries } from "./taskSummaries"

const CHIP =
  "inline-flex h-6 max-w-[14rem] shrink-0 items-center gap-1.5 rounded-md bg-app-sunk px-1.5 text-caption font-medium text-foreground transition-colors duration-150"

/** The task a checklist line became: its identifier, status and assignee. It opens the task */
export function TaskLineChip({ taskId, summaries }: { taskId: string; summaries: TaskSummaries }) {
  const navigate = useNavigate()
  const summary = useSyncExternalStore(
    summaries.subscribe,
    () => summaries.get(taskId),
    () => summaries.get(taskId),
  )

  const failed = useSyncExternalStore(
    summaries.subscribe,
    () => summaries.hasFailed(taskId),
    () => summaries.hasFailed(taskId),
  )

  useEffect(() => summaries.want(taskId), [summaries, taskId])

  if (!summary) return <span aria-hidden="true" className={cn(CHIP, "w-[4.5rem]", !failed && "animate-pulse")} />
  if (summary.hidden) {
    return (
      <span title="You can't open this task" className={cn(CHIP, "text-muted-foreground")}>
        <Lock aria-hidden="true" className="size-[0.85rem]" />
        Hidden task
      </span>
    )
  }

  const open = () =>
    void tasksAPI.getTask(taskId).then(
      (task) => navigate(task.project ? `/project/${task.project.slug}?task=${task.id}` : `/?task=${task.id}`),
      () => toast.error("Couldn't open the task. Try again."),
    )

  return (
    <button
      type="button"
      onClick={open}
      title={summary.title}
      aria-label={`Open task ${summary.identifier ?? summary.title}`}
      className={cn(
        CHIP,
        "cursor-pointer hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      <StatusIcon status={summary.status} className="size-[0.85rem]" />
      <span className="truncate tabular-nums">{summary.identifier ?? "Task"}</span>
      {summary.assignee && <UserAvatar user={avatarOf(summary.assignee)} size="xs" />}
    </button>
  )
}
