import { forwardRef, type HTMLAttributes, type KeyboardEvent, type MouseEvent } from "react"
import type { Task } from "@/lib/api/tasks"
import { parseDueDate } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { PriorityIcon } from "@/components/ui/priority-icon"
import { UserAvatar } from "@/components/ui/user-avatar"
import { DueLabel } from "./DueLabel"
import { ProjectChip } from "./ProjectChip"

type TaskCardProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  task: Task
  onOpen: (task: Task) => void
  selected?: boolean
  showProject?: boolean
  showAssignee?: boolean
}

export const TaskCard = forwardRef<HTMLDivElement, TaskCardProps>(function TaskCard(
  { task, onOpen, selected = false, showProject = false, showAssignee = true, className, onClick, onKeyDown, ...props },
  ref,
) {
  const done = task.status === "done"
  const hasDue = parseDueDate(task.due_date) !== null
  // A personal task with no priority has nothing to say in the top row, so the card drops it
  const topRow = task.priority !== "none" || !!task.identifier
  const avatar = showAssignee && <UserAvatar user={task.assignee} size="xs" className="ml-auto" />

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    onClick?.(e)
    if (!e.defaultPrevented) onOpen(task)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented || e.target !== e.currentTarget) return
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      onOpen(task)
    }
  }

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      data-selected={selected || undefined}
      {...props}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex cursor-pointer flex-col gap-2 rounded-lg bg-card px-2.5 py-2.5 text-left ring-[0.0625rem] ring-border transition-[background-color,box-shadow] duration-150 select-none hover:bg-app-hover focus-visible:outline-[0.125rem] focus-visible:outline-offset-[0.125rem] focus-visible:outline-ring",
        selected && "bg-app-selected ring-[0.09375rem] ring-app-sky-strong hover:bg-app-selected",
        className,
      )}
    >
      {topRow && (
        <span className="flex min-w-0 items-center gap-1.5">
          <PriorityIcon priority={task.priority} />
          {task.identifier && (
            <span className="truncate text-caption font-medium tracking-[0.01em] text-muted-foreground tabular-nums">
              {task.identifier}
            </span>
          )}
          {avatar}
        </span>
      )}
      <span
        className={cn(
          "block text-ui leading-[1.35] font-medium [overflow-wrap:anywhere]",
          done ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {task.title}
      </span>
      {(showProject || hasDue || (!topRow && avatar)) && (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {showProject && <ProjectChip project={task.project} className="max-w-full" />}
          <DueLabel due={task.due_date} done={done || task.status === "backlog"} />
          {!topRow && avatar}
        </span>
      )}
    </div>
  )
})
