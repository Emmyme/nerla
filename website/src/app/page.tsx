import { useEffect, useMemo, useRef, useState } from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { toast } from "sonner"
import { ChevronDown } from "@/components/icons"
import { DayAgenda, useAgendaWeek } from "@/components/home/DayAgenda"
import { homeSummary, NOTHING_TODAY } from "@/components/home/homeSummary"
import { FirstTip } from "@/components/onboarding/FirstTip"
import { GettingStarted } from "@/components/onboarding/GettingStarted"
import { PageHeader } from "@/components/shell/PageHeader"
import { groupTasks } from "@/components/tasks/groupTasks"
import { NewTaskDialog } from "@/components/tasks/NewTaskDialog"
import { ProjectChip } from "@/components/tasks/ProjectChip"
import { TaskBoard } from "@/components/tasks/TaskBoard"
import { TaskList } from "@/components/tasks/TaskList"
import { TaskPanel } from "@/components/tasks/TaskPanel"
import { TaskPanelDock, TaskPanelSheet } from "@/components/tasks/TaskPanelSheet"
import { usePresence } from "@/lib/motion"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { useDocumentTitle } from "@/lib/useDocumentTitle"
import { TaskErrorBar, TasksPlaceholder, TasksSkeleton, type TaskView } from "@/components/tasks/TaskStates"
import { TOOLBAR_PILL } from "@/components/tasks/TaskToolbar"
import { neighborOf, useTaskPanelRoute } from "@/components/tasks/useTaskPanelRoute"
import { Button } from "@/components/ui/button"
import { CatNapping } from "@/components/ui/cat-scenes"
import { CreateFab } from "@/components/ui/create-fab"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Select, SelectContent, SelectItem } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { tasksAPI, type TaskPatch, type TaskProjectRef } from "@/lib/api/tasks"
import type { UserSummary } from "@/lib/api/users"
import { formatDayTitle } from "@/lib/dates"
import { loadOnboarding } from "@/lib/onboarding"
import { notifyTasksChanged, useTaskList } from "@/lib/taskStore"
import { movedToTrash } from "@/lib/trashToast"
import { useProjects } from "@/lib/useProjects"
import { useTaskShortcuts } from "@/lib/useTaskShortcuts"
import { readViewPreference, saveViewPreference } from "@/lib/viewPreference"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"
import { ACTIVE_STATUSES, type TaskStatus } from "@/types/tasks"

const VIEW_KEY = "nerla-home-view"
const ALL = "all"
const PERSONAL = "personal"
const MINUTE_MS = 60_000

const VIEWS = [
  { value: "board" as const, label: "Board" },
  { value: "list" as const, label: "List" },
]
const VIEW_VALUES: readonly TaskView[] = ["board", "list"]

// data-full-bleed drops the shell padding on desktop, so the column scrolls on its own and the panel can dock full height
const FRAME = "flex flex-col lg:grid lg:h-full lg:grid-rows-[minmax(0,1fr)]"
const COLUMN =
  "flex min-w-0 flex-col gap-4 max-lg:pb-14 lg:min-h-0 lg:overflow-y-auto lg:px-6 lg:pb-[max(1.5rem,var(--chat-space,0rem))] lg:pt-6"

function useNow(): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const current = new Date()
      setNow(current)
      timer = setTimeout(tick, MINUTE_MS - (current.getTime() % MINUTE_MS))
    }
    timer = setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS))
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      clearTimeout(timer)
      tick()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  return now
}

export default function Home() {
  const now = useNow()
  const desktop = useIsDesktop()
  useDocumentTitle("Home")
  const { user } = useAuth()
  const { projects } = useProjects()
  const { tasks, status, error, source, reload, updateTask, addTask, removeTask } = useTaskList(tasksAPI.getUserTasks, "my")
  const agenda = useAgendaWeek(now)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { openTask, panelOpen, shown, selectedId, setSelectedId, openPanel, closePanel, step, closeAfterDelete } = useTaskPanelRoute({
    tasks,
    status,
    heading: headingRef,
  })
  const [view, setView] = useState<TaskView>(() => readViewPreference(VIEW_KEY, "board", VIEW_VALUES))
  const [filter, setFilter] = useState(ALL)
  const [creating, setCreating] = useState<TaskStatus | null>(null)

  const me = useMemo<UserSummary | null>(
    () => (user ? { id: user.id, first_name: user.firstName, last_name: user.lastName, avatar_url: user.avatarUrl ?? null } : null),
    [user],
  )

  const active = useMemo(() => tasks.filter((task) => task.status !== "backlog"), [tasks])

  const filterProjects = useMemo(() => {
    const list: TaskProjectRef[] = projects.filter((project) => project.status !== "archived" || project.id === filter)
    for (const task of active) {
      if (task.project && !list.some((project) => project.id === task.project_id)) list.push(task.project)
    }
    return list
  }, [projects, active, filter])

  const activeFilter = filter === ALL || filter === PERSONAL || filterProjects.some((p) => p.id === filter) ? filter : ALL
  const visible = useMemo(() => {
    if (activeFilter === ALL) return active
    const projectId = activeFilter === PERSONAL ? null : activeFilter
    return active.filter((task) => task.project_id === projectId)
  }, [active, activeFilter])
  const order = useMemo(() => groupTasks(visible, "status").flatMap((group) => group.tasks), [visible])

  const effectiveView: TaskView = desktop ? view : "list"
  const listActive = effectiveView === "list"
  const selectedTask = order.find((task) => task.id === selectedId)
  const loadFailed = status === "error" && tasks.length === 0

  const panelMembers = useMemo(() => {
    const project = shown?.project_id ? projects.find((p) => p.id === shown.project_id) : undefined
    const members = [...(project?.members ?? [])]
    if (me && !members.some((member) => member.id === me.id)) members.push(me)
    return members
  }, [shown?.project_id, projects, me])

  const deleteShown = async () => {
    if (!shown) return
    const next = neighborOf(order, shown.id)
    const entry = await tasksAPI.deleteTask(shown.id)
    removeTask(shown.id)
    closeAfterDelete(next)
    movedToTrash("Task moved to the trash", entry, (restored) => {
      if (restored.kind === "task") addTask(restored.task)
      notifyTasksChanged(source)
    })
  }

  const changeTask = async (id: string, patch: TaskPatch, options?: { quiet?: boolean }) => {
    const failure = await updateTask(id, patch, options)
    if (failure === null && patch.status === "backlog") toast("Moved to Backlog")
    return failure
  }

  const changeView = (next: TaskView) => {
    setView(next)
    saveViewPreference(VIEW_KEY, next)
  }

  useTaskShortcuts({
    new: () => setCreating("todo"),
    next: listActive ? () => step(order, 1) : undefined,
    prev: listActive ? () => step(order, -1) : undefined,
    open: listActive && selectedTask ? () => openPanel(selectedTask) : undefined,
    close: panelOpen ? closePanel : undefined,
  })

  const tasksSettled = status !== "loading"
  const summary = (() => {
    if (!tasksSettled || agenda.todayStatus === "loading") return undefined
    const text = homeSummary({ events: agenda.todayEvents, tasks: active, now })
    const partial = agenda.todayStatus === "error" || loadFailed
    return partial && text === NOTHING_TODAY ? null : text
  })()

  const defaultProjectId = activeFilter === ALL || activeFilter === PERSONAL ? null : activeFilter
  const filterName =
    activeFilter === ALL ? null : activeFilter === PERSONAL ? "Personal" : filterProjects.find((p) => p.id === activeFilter)?.name
  const panelTask = desktop ? openTask : shown
  const inline = desktop && panelOpen
  const dock = usePresence(inline)
  // The column stays while the panel eases out
  const docked = dock.mounted

  const panel = (
    <TaskPanel
      task={panelTask}
      members={panelMembers}
      projects={projects}
      onClose={closePanel}
      onUpdate={(patch) => (panelTask ? changeTask(panelTask.id, patch, { quiet: true }) : Promise.resolve(null))}
      onDelete={deleteShown}
    />
  )

  return (
    <div data-full-bleed="" className={cn(FRAME, docked ? "lg:grid-cols-[minmax(0,1fr)_23rem]" : "lg:grid-cols-[minmax(0,1fr)]")}>
      <div className={COLUMN}>
        <PageHeader
          title={formatDayTitle(now)}
          meta={summary === undefined ? <Skeleton aria-hidden="true" className="mt-0.5 h-[1.1rem] w-[15rem] max-w-full" /> : summary}
          actions={
            desktop && (
              <Button type="button" shortcut="C" onClick={() => setCreating("todo")}>
                New task
              </Button>
            )
          }
        />
        {!desktop && <CreateFab label="New task" shortcut="c" onClick={() => setCreating("todo")} />}
        <FirstTip id="home" />

        <div className={cn("grid items-start gap-4", !docked && "lg:grid-cols-[minmax(0,1fr)_20rem]")}>
          {!desktop && <DayAgenda now={now} agenda={agenda} compact />}

          <div className="flex min-w-0 flex-col gap-4">
            <GettingStarted onNewTask={() => setCreating("todo")} />
            <section aria-labelledby="home-my-tasks" className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2
                  ref={headingRef}
                  id="home-my-tasks"
                  tabIndex={-1}
                  className="mr-auto rounded-sm text-lead font-semibold tracking-normal text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
                >
                  My tasks
                  {tasksSettled && !loadFailed && (
                    <span className="ml-1 text-caption font-medium text-muted-foreground tabular-nums">{visible.length}</span>
                  )}
                </h2>
                <ProjectFilter value={activeFilter} projects={filterProjects} onChange={setFilter} />
                {desktop && <SegmentedControl label="View" value={view} onChange={changeView} options={VIEWS} />}
              </div>

              <TaskErrorBar error={error} hidden={loadFailed} className="mb-3" />

              <div data-task-nav="">
                {status === "loading" ? (
                  <TasksSkeleton view={effectiveView} />
                ) : loadFailed ? (
                  <TasksPlaceholder role="alert" text={error ?? "Couldn't load tasks."} action="Try again" onAction={reload} />
                ) : visible.length === 0 ? (
                  <TasksPlaceholder
                    art={filterName ? undefined : <CatNapping />}
                    text={filterName ? (activeFilter === PERSONAL ? "No personal tasks" : `No tasks in ${filterName}`) : "All caught up"}
                    action="New task"
                    onAction={() => setCreating("todo")}
                  />
                ) : effectiveView === "board" ? (
                  <TaskBoard
                    tasks={visible}
                    onOpen={openPanel}
                    onMove={(id, next) => void changeTask(id, { status: next })}
                    statuses={ACTIVE_STATUSES}
                    onAdd={setCreating}
                    selectedId={openTask?.id ?? null}
                    showProject
                    showAssignee={false}
                  />
                ) : (
                  <TaskList
                    tasks={visible}
                    groupBy="status"
                    statuses={ACTIVE_STATUSES}
                    onOpen={openPanel}
                    onAdd={(next) => setCreating(next ?? "todo")}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    showProject
                    showAssignee={false}
                  />
                )}
              </div>
            </section>
          </div>

          {desktop && !docked && <DayAgenda now={now} agenda={agenda} />}
        </div>
      </div>

      {desktop ? (
        docked && <TaskPanelDock presence={dock}>{panel}</TaskPanelDock>
      ) : (
        <TaskPanelSheet
          open={panelOpen}
          onOpenChange={(open) => !open && closePanel()}
          label={shown ? [shown.identifier, shown.title].filter(Boolean).join(" ") : "Task"}
        >
          {panel}
        </TaskPanelSheet>
      )}

      <NewTaskDialog
        open={creating !== null}
        onOpenChange={(open) => !open && setCreating(null)}
        defaultProjectId={defaultProjectId}
        defaultStatus={creating ?? "todo"}
        onCreated={(task) => {
          void loadOnboarding()
          if (task.assigned_to === user?.id) addTask(task)
          if (task.status === "backlog") toast("Added to Backlog")
        }}
        source={source}
      />
    </div>
  )
}

function ProjectFilter({ value, projects, onChange }: { value: string; projects: TaskProjectRef[]; onChange: (value: string) => void }) {
  const current = projects.find((project) => project.id === value) ?? null
  const text = value === ALL ? "All projects" : value === PERSONAL ? "Personal" : (current?.name ?? "All projects")

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectPrimitive.Trigger aria-label={`Project filter: ${text}`} className={TOOLBAR_PILL}>
        {value === ALL ? (
          <span className="truncate">All projects</span>
        ) : (
          <ProjectChip project={value === PERSONAL ? null : current} className="text-ui text-inherit" />
        )}
        <ChevronDown aria-hidden="true" weight="bold" className="size-[0.7rem] shrink-0" />
      </SelectPrimitive.Trigger>
      <SelectContent className="max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-[12rem]">
        <SelectItem value={ALL} textValue="All projects">
          All projects
        </SelectItem>
        <SelectItem value={PERSONAL} textValue="Personal">
          <ProjectChip project={null} className="text-inherit" />
        </SelectItem>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id} textValue={project.name}>
            <ProjectChip project={project} className="text-inherit" />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
