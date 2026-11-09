import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ChevronDown, Plus } from "@/components/icons"
import { Collapse } from "@/components/ui/collapse"
import type { Task } from "@/lib/api/tasks"
import { cn } from "@/lib/utils"
import { PriorityIcon } from "@/components/ui/priority-icon"
import { StatusIcon } from "@/components/ui/status-icon"
import { UserAvatar } from "@/components/ui/user-avatar"
import type { TaskPriority, TaskStatus } from "@/types/tasks"
import { groupTasks, UNASSIGNED_KEY, type TaskGroup, type TaskGroupBy } from "./groupTasks"
import { TaskRow } from "./TaskRow"

const STATUS_TINT: Record<TaskStatus, string> = {
  backlog: "bg-app-col-backlog",
  todo: "bg-app-col-todo",
  in_progress: "bg-app-col-progress",
  done: "bg-app-col-done",
}

type TaskListProps = {
  tasks: Task[]
  groupBy: TaskGroupBy
  onOpen: (task: Task) => void
  /** Absent when the viewer can only read the tasks */
  onAdd?: (status?: TaskStatus) => void
  selectedId?: string | null
  onSelect?: (id: string) => void
  showProject?: boolean
  showAssignee?: boolean
  /** Which status groups exist when grouping by status, all of them by default */
  statuses?: readonly TaskStatus[]
}

function GroupIcon({ group, by }: { group: TaskGroup; by: TaskGroupBy }) {
  if (by === "status") return <StatusIcon status={group.key as TaskStatus} />
  if (by === "priority") return <PriorityIcon priority={group.key as TaskPriority} />
  if (by === "assignee") return <UserAvatar user={group.key === UNASSIGNED_KEY ? null : group.tasks[0].assignee} size="xs" />
  return null
}

export function TaskList({
  tasks,
  groupBy,
  onOpen,
  onAdd,
  selectedId = null,
  onSelect,
  showProject = false,
  showAssignee = true,
  statuses,
}: TaskListProps) {
  const groups = useMemo(() => groupTasks(tasks, groupBy, statuses), [tasks, groupBy, statuses])
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const [revealed, setRevealed] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const baseId = useId()

  const stateKey = (key: string) => `${groupBy}:${key}`
  const isCollapsed = (key: string) => toggled[stateKey(key)] ?? (groupBy === "status" && (key === "done" || key === "backlog"))
  const setCollapsed = (key: string, collapsed: boolean) => setToggled((current) => ({ ...current, [stateKey(key)]: collapsed }))

  const revealKey = selectedId === null ? null : `${groupBy}:${selectedId}`
  if (revealKey !== revealed) {
    const holder = groups.find((group) => group.tasks.some((task) => task.id === selectedId))
    if (holder || revealKey === null) setRevealed(revealKey)
    if (holder && isCollapsed(holder.key)) setCollapsed(holder.key, false)
  }

  const visibleIds = groups.flatMap((group) => (groupBy !== "none" && isCollapsed(group.key) ? [] : group.tasks.map((task) => task.id)))
  const tabStopId = selectedId !== null && visibleIds.includes(selectedId) ? selectedId : visibleIds[0]

  useEffect(() => {
    const container = containerRef.current
    if (!selectedId || !container) return
    const row = container.querySelector<HTMLElement>(`[data-task-id="${selectedId}"]`)
    if (!row) return
    row.scrollIntoView({ block: "nearest" })
    if (
      container.contains(document.activeElement) &&
      document.activeElement !== row &&
      document.activeElement?.hasAttribute("data-task-id")
    ) {
      row.focus({ preventScroll: true })
    }
  }, [selectedId, groupBy])

  if (tasks.length === 0) return null

  return (
    <div ref={containerRef} className="flex flex-col gap-3.5">
      {groups.map((group) => {
        const collapsed = groupBy !== "none" && isCollapsed(group.key)
        const headerId = `${baseId}-${group.key}-header`
        const bodyId = `${baseId}-${group.key}-body`
        const addStatus = groupBy === "status" ? (group.key as TaskStatus) : undefined

        return (
          <section key={group.key} className="overflow-hidden rounded-lg ring-[0.0625rem] ring-border">
            {groupBy !== "none" && (
              <div className={cn("flex items-center pr-1.5", groupBy === "status" ? STATUS_TINT[group.key as TaskStatus] : "bg-app-sunk")}>
                <button
                  type="button"
                  id={headerId}
                  aria-expanded={!collapsed}
                  aria-controls={bodyId}
                  onClick={() => setCollapsed(group.key, !collapsed)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 pl-3 text-left text-body font-semibold text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                >
                  <span aria-hidden="true" className="flex w-[0.8rem] shrink-0 justify-center text-muted-foreground">
                    <ChevronDown className={cn("motion-rotate size-[0.75rem]", collapsed && "-rotate-90")} weight="bold" />
                  </span>
                  <span aria-hidden="true" className="flex shrink-0">
                    <GroupIcon group={group} by={groupBy} />
                  </span>
                  <span className="truncate">{group.label}</span>
                  <span className="text-caption font-medium text-muted-foreground tabular-nums">{group.tasks.length}</span>
                </button>
                {onAdd && (
                  <button
                    type="button"
                    aria-label={addStatus ? `New task in ${group.label}` : "New task"}
                    onClick={() => onAdd(addStatus)}
                    className="flex size-[1.5rem] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-card hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset max-lg:size-11"
                  >
                    <Plus className="size-[1rem]" weight="bold" />
                  </button>
                )}
              </div>
            )}
            <Collapse id={bodyId} open={!collapsed} unmountClosed>
              <div
                role="grid"
                aria-labelledby={groupBy !== "none" ? headerId : undefined}
                aria-label={groupBy === "none" ? "Tasks" : undefined}
                hidden={group.tasks.length === 0}
              >
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onOpen={onOpen}
                    onSelect={onSelect}
                    selected={task.id === selectedId}
                    tabbable={task.id === tabStopId}
                    showProject={showProject}
                    showAssignee={showAssignee}
                  />
                ))}
              </div>
            </Collapse>
          </section>
        )
      })}
    </div>
  )
}
