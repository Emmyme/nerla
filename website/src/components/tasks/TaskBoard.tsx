import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type Ref } from "react"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  MeasuringStrategy,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core"
import { ChevronLeft, Plus } from "@/components/icons"
import type { Task } from "@/lib/api/tasks"
import { cn } from "@/lib/utils"
import { StatusIcon } from "@/components/ui/status-icon"
import { STATUS_LABEL, TASK_STATUSES, type TaskStatus } from "@/types/tasks"
import { readBacklogOpen, saveBacklogOpen } from "./boardFold"
import { groupTasks } from "./groupTasks"
import { TaskCard } from "./TaskCard"

const COLUMN_TONE: Record<TaskStatus, { tint: string; ring: string }> = {
  backlog: { tint: "bg-app-col-backlog", ring: "ring-app-status-backlog" },
  todo: { tint: "bg-app-col-todo", ring: "ring-app-status-todo" },
  in_progress: { tint: "bg-app-col-progress", ring: "ring-app-status-progress" },
  done: { tint: "bg-app-col-done", ring: "ring-app-status-done" },
}

const HEADER_BUTTON =
  "flex size-[1.5rem] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring"

const KEYBOARD_CODES = { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] }

const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  return hits.length > 0 ? hits : rectIntersection(args)
}

const columnCoordinates =
  (statuses: readonly TaskStatus[]): KeyboardCoordinateGetter =>
  (event, { context, currentCoordinates }) => {
    if (event.code === "ArrowUp" || event.code === "ArrowDown") {
      event.preventDefault()
      return
    }
    if (event.code !== "ArrowRight" && event.code !== "ArrowLeft") return
    event.preventDefault()

    const from = (context.over?.id ?? context.active?.data.current?.status) as TaskStatus | undefined
    const index = from ? statuses.indexOf(from) : -1
    const target = statuses[index + (event.code === "ArrowRight" ? 1 : -1)]
    const column = target && context.droppableRects.get(target)
    const dragged = context.collisionRect
    if (!column || !dragged) return

    const top = Math.min(Math.max(currentCoordinates.y, column.top), column.bottom - dragged.height)
    // A card wider than the folded rail would mostly overlap the next column, so its right edge lines up with the rail's
    const x = column.width < dragged.width ? column.right - dragged.width : column.left + (column.width - dragged.width) / 2
    return { x, y: top }
  }

function DraggableCard({
  task,
  onOpen,
  selected,
  showProject,
  showAssignee,
}: {
  task: Task
  onOpen: (task: Task) => void
  selected: boolean
  showProject: boolean
  showAssignee: boolean
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, data: { status: task.status } })

  return (
    <TaskCard
      ref={setNodeRef}
      task={task}
      onOpen={onOpen}
      selected={selected}
      showProject={showProject}
      showAssignee={showAssignee}
      {...attributes}
      {...listeners}
      onKeyDown={(e) => {
        if (isDragging) {
          e.preventDefault()
          return
        }
        listeners?.onKeyDown?.(e)
      }}
      className={cn("touch-manipulation", isDragging && "opacity-40")}
    />
  )
}

function Column({
  status,
  tasks,
  onOpen,
  onAdd,
  selectedId,
  showProject,
  showAssignee,
  readOnly,
  onFold,
  foldRef,
}: {
  status: TaskStatus
  tasks: Task[]
  onOpen: (task: Task) => void
  onAdd?: (status: TaskStatus) => void
  onFold?: () => void
  foldRef?: Ref<HTMLButtonElement>
  selectedId: string | null
  showProject: boolean
  showAssignee: boolean
  readOnly: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: readOnly })
  const tone = COLUMN_TONE[status]
  const label = STATUS_LABEL[status]

  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-xl p-2 transition-shadow duration-150",
        tone.tint,
        isOver && cn("ring-[0.09375rem]", tone.ring),
      )}
    >
      <div className="flex items-center gap-2 px-1.5 py-1 text-body font-semibold text-foreground">
        <StatusIcon status={status} />
        <span className="truncate">{label}</span>
        <span className="text-caption font-medium text-muted-foreground tabular-nums">{tasks.length}</span>
        {(onAdd || onFold) && (
          <span className="-my-0.5 ml-auto flex items-center gap-0.5">
            {onAdd && (
              <button type="button" aria-label={`New task in ${label}`} onClick={() => onAdd(status)} className={HEADER_BUTTON}>
                <Plus className="size-[1rem]" weight="bold" />
              </button>
            )}
            {onFold && (
              <button
                ref={foldRef}
                type="button"
                aria-label={`Fold ${label}`}
                aria-expanded="true"
                onClick={onFold}
                className={HEADER_BUTTON}
              >
                <ChevronLeft className="size-[1rem]" weight="bold" />
              </button>
            )}
          </span>
        )}
      </div>
      {tasks.map((task) =>
        readOnly ? (
          <TaskCard
            key={task.id}
            task={task}
            onOpen={onOpen}
            selected={task.id === selectedId}
            showProject={showProject}
            showAssignee={showAssignee}
          />
        ) : (
          <DraggableCard
            key={task.id}
            task={task}
            onOpen={onOpen}
            selected={task.id === selectedId}
            showProject={showProject}
            showAssignee={showAssignee}
          />
        ),
      )}
    </div>
  )
}

function BacklogRail({
  count,
  onUnfold,
  readOnly,
  railRef,
}: {
  count: number
  onUnfold: () => void
  readOnly: boolean
  railRef: MutableRefObject<HTMLButtonElement | null>
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "backlog", disabled: readOnly })
  const tone = COLUMN_TONE.backlog
  const setRefs = useCallback(
    (node: HTMLButtonElement | null) => {
      setNodeRef(node)
      railRef.current = node
    },
    [setNodeRef, railRef],
  )

  return (
    <button
      ref={setRefs}
      type="button"
      aria-expanded="false"
      aria-label={`Backlog, ${count} ${count === 1 ? "task" : "tasks"}, show column`}
      onClick={onUnfold}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col items-center gap-2 rounded-xl px-1 py-3 transition-shadow duration-150 hover:ring-[0.0625rem] hover:ring-border focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
        tone.tint,
        isOver && cn("ring-[0.09375rem]", tone.ring),
      )}
    >
      <StatusIcon status="backlog" />
      <span className="text-caption font-medium text-muted-foreground tabular-nums">{count}</span>
      <span className="text-body font-semibold text-foreground [writing-mode:vertical-rl]">{STATUS_LABEL.backlog}</span>
    </button>
  )
}

export function TaskBoard({
  tasks,
  onOpen,
  onMove,
  onAdd,
  selectedId = null,
  showProject = false,
  showAssignee = true,
  statuses = TASK_STATUSES,
}: {
  tasks: Task[]
  onOpen: (task: Task) => void
  /** Without it the cards stay put, for a viewer who can only read the tasks */
  onMove?: (id: string, status: TaskStatus) => void
  onAdd?: (status: TaskStatus) => void
  selectedId?: string | null
  showProject?: boolean
  showAssignee?: boolean
  statuses?: readonly TaskStatus[]
}) {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null)
  const [backlogOpen, setBacklogOpen] = useState(readBacklogOpen)
  const railRef = useRef<HTMLButtonElement | null>(null)
  const foldRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  const [revealed, setRevealed] = useState<string | null>(null)
  const hasBacklog = statuses.includes("backlog")
  const columns = useMemo(() => new Map(groupTasks(tasks, "status").map((group) => [group.key, group.tasks])), [tasks])
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])

  if (selectedId !== revealed) {
    setRevealed(selectedId)
    if (hasBacklog && !backlogOpen && columns.get("backlog")?.some((task) => task.id === selectedId)) setBacklogOpen(true)
  }
  const activeTask = activeId === null ? undefined : byId.get(String(activeId))

  const isStatus = (id: UniqueIdentifier | undefined): id is TaskStatus => statuses.includes(id as TaskStatus)
  const getCoordinates = useMemo(() => columnCoordinates(statuses), [statuses])

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { keyboardCodes: KEYBOARD_CODES, coordinateGetter: getCoordinates }),
  )

  const toggleBacklog = () => {
    const next = !backlogOpen
    refocus.current = true
    setBacklogOpen(next)
    saveBacklogOpen(next)
  }

  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    ;(backlogOpen ? foldRef : railRef).current?.focus()
  }, [backlogOpen])

  const titleOf = (id: UniqueIdentifier) => byId.get(String(id))?.title ?? "Task"
  const columnOf = (id: UniqueIdentifier | undefined) => (isStatus(id) ? STATUS_LABEL[id] : null)

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      columnOf(over?.id) ? `${titleOf(active.id)} is over ${columnOf(over?.id)}.` : `${titleOf(active.id)} is not over a column.`,
    onDragEnd: ({ active, over }) => {
      const column = columnOf(over?.id)
      if (!column) return `${titleOf(active.id)} was put back.`
      return over?.id === active.data.current?.status
        ? `${titleOf(active.id)} stays in ${column}.`
        : `${titleOf(active.id)} was moved to ${column}.`
    },
    onDragCancel: ({ active }) => `Moving ${titleOf(active.id)} was cancelled.`,
  }

  const handleDragStart = ({ active }: DragStartEvent) => setActiveId(active.id)

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null)
    const task = byId.get(String(active.id))
    if (task && isStatus(over?.id) && over.id !== task.status) onMove?.(task.id, over.id)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            "Press enter to open the task. To move it, press space, use the left and right arrow keys to pick a column, then press space again to drop it, or escape to cancel.",
        },
      }}
    >
      <div
        className={cn(
          "grid gap-2.5",
          hasBacklog && !backlogOpen
            ? "grid-cols-[2.75rem_repeat(3,minmax(0,1fr))]"
            : statuses.length === 3
              ? "grid-cols-3"
              : "grid-cols-4",
          activeId === null ? "items-start" : "items-stretch",
        )}
      >
        {statuses.map((status) =>
          status === "backlog" && !backlogOpen ? (
            <BacklogRail
              key={status}
              count={columns.get(status)?.length ?? 0}
              onUnfold={toggleBacklog}
              readOnly={!onMove}
              railRef={railRef}
            />
          ) : (
            <Column
              key={status}
              status={status}
              tasks={columns.get(status) ?? []}
              onOpen={onOpen}
              onAdd={onAdd}
              onFold={status === "backlog" ? toggleBacklog : undefined}
              foldRef={status === "backlog" ? foldRef : undefined}
              readOnly={!onMove}
              selectedId={selectedId}
              showProject={showProject}
              showAssignee={showAssignee}
            />
          ),
        )}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <TaskCard
            task={activeTask}
            onOpen={() => {}}
            showProject={showProject}
            showAssignee={showAssignee}
            tabIndex={-1}
            aria-hidden="true"
            className="cursor-grabbing shadow-[var(--shadow-popover)] hover:bg-card"
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
