import type { Task } from "@/lib/api/tasks"
import { cn } from "@/lib/utils"
import { PriorityIcon } from "@/components/ui/priority-icon"
import { StatusIcon } from "@/components/ui/status-icon"
import { UserAvatar } from "@/components/ui/user-avatar"
import { DueLabel } from "./DueLabel"
import { ProjectChip } from "./ProjectChip"

// Fixed project and due tracks keep the columns lined up from row to row
const COLUMNS = {
  project:
    "grid-cols-[1rem_1rem_minmax(0,1fr)_auto_auto_1.5rem] sm:grid-cols-[1rem_3.6rem_1rem_minmax(0,1fr)_minmax(0,11rem)_5.5rem_1.5rem]",
  projectOnly: "grid-cols-[1rem_1rem_minmax(0,1fr)_auto_auto] sm:grid-cols-[1rem_3.6rem_1rem_minmax(0,1fr)_minmax(0,11rem)_5.5rem]",
  plain: "grid-cols-[1rem_1rem_minmax(0,1fr)_auto_1.5rem] sm:grid-cols-[1rem_3.6rem_1rem_minmax(0,1fr)_auto_1.5rem]",
  plainOnly: "grid-cols-[1rem_1rem_minmax(0,1fr)_auto] sm:grid-cols-[1rem_3.6rem_1rem_minmax(0,1fr)_auto]",
}

export function TaskRow({
  task,
  onOpen,
  onSelect,
  selected = false,
  tabbable = true,
  showProject = false,
  showAssignee = true,
}: {
  task: Task
  onOpen: (task: Task) => void
  onSelect?: (id: string) => void
  selected?: boolean
  tabbable?: boolean
  showProject?: boolean
  showAssignee?: boolean
}) {
  const done = task.status === "done"
  const columns = showProject ? (showAssignee ? COLUMNS.project : COLUMNS.projectOnly) : showAssignee ? COLUMNS.plain : COLUMNS.plainOnly

  return (
    <div role="row" className="border-b-[0.0625rem] border-border last:border-b-0">
      <button
        type="button"
        role="gridcell"
        aria-selected={selected}
        tabIndex={tabbable ? 0 : -1}
        data-task-id={task.id}
        onFocus={() => onSelect?.(task.id)}
        onClick={() => {
          onSelect?.(task.id)
          onOpen(task)
        }}
        className={cn(
          "grid w-full cursor-pointer items-center gap-2.5 bg-card px-3 py-2 text-left text-body transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
          columns,
          selected && "bg-app-selected hover:bg-app-selected",
        )}
      >
        <PriorityIcon priority={task.priority} />
        <span className="truncate text-caption font-medium tracking-[0.01em] text-muted-foreground tabular-nums max-sm:hidden">
          {task.identifier}
        </span>
        <StatusIcon status={task.status} />
        <span className={cn("truncate font-medium", done ? "text-muted-foreground" : "text-foreground")}>{task.title}</span>
        {showProject && (
          <>
            <span className="flex min-w-0 justify-self-start max-sm:hidden">
              <ProjectChip project={task.project} />
            </span>
            <span className="flex sm:hidden">
              <ProjectChip project={task.project} iconOnly />
            </span>
          </>
        )}
        <span className="flex justify-end justify-self-end">
          <DueLabel due={task.due_date} done={done || task.status === "backlog"} />
        </span>
        {showAssignee && <UserAvatar user={task.assignee} size="sm" />}
      </button>
    </div>
  )
}
