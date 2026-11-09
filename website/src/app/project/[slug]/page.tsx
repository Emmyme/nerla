import { FirstTip } from "@/components/onboarding/FirstTip"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router"
import { Pin, Settings, Warning } from "@/components/icons"
import { useRegisterCommands, type Command } from "@/components/command/registry"
import { FileBrowser } from "@/components/files/FileBrowser"
import { filesPath } from "@/components/files/FilesNav"
import type { FilePlace } from "@/components/files/useFiles"
import { ProjectSettingsDialog } from "@/components/projects/ProjectSettingsDialog"
import { PageHeader } from "@/components/shell/PageHeader"
import { groupTasks, userName, type TaskGroupBy } from "@/components/tasks/groupTasks"
import { NewTaskDialog } from "@/components/tasks/NewTaskDialog"
import { TaskBoard } from "@/components/tasks/TaskBoard"
import { TaskList } from "@/components/tasks/TaskList"
import { TaskPanel, type TaskPanelPicker } from "@/components/tasks/TaskPanel"
import { TaskPanelDock, TaskPanelSheet } from "@/components/tasks/TaskPanelSheet"
import { usePresence } from "@/lib/motion"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { useDocumentTitle } from "@/lib/useDocumentTitle"
import { TaskErrorBar, TasksPlaceholder, TasksSkeleton, type TaskView } from "@/components/tasks/TaskStates"
import { filterTasks, GroupSelect, NO_FILTERS, TaskFilterMenu, type TaskFilters } from "@/components/tasks/TaskToolbar"
import { findTaskRow, neighborOf, useTaskPanelRoute } from "@/components/tasks/useTaskPanelRoute"
import { Button } from "@/components/ui/button"
import { CatNapping } from "@/components/ui/cat-scenes"
import { CreateFab } from "@/components/ui/create-fab"
import { IdentityTile } from "@/components/ui/identity-tile"
import { NotFoundView } from "@/components/ui/not-found-view"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Skeleton } from "@/components/ui/skeleton"
import { ApiError, PROJECT_READ_ONLY_EVENT } from "@/lib/api/request"
import { projectsAPI, type Project } from "@/lib/api/projects"
import { tasksAPI } from "@/lib/api/tasks"
import { messageOf, notifyTasksChanged, useTaskList } from "@/lib/taskStore"
import { movedToTrash } from "@/lib/trashToast"
import { rememberProject } from "@/lib/recentProjects"
import { notifyProjectsChanged, setProjectPinned, useProjects } from "@/lib/useProjects"
import { useTaskShortcuts } from "@/lib/useTaskShortcuts"
import { cn } from "@/lib/utils"
import { readViewPreference, saveViewPreference } from "@/lib/viewPreference"
import type { TaskStatus } from "@/types/tasks"
import { toast } from "sonner"

type LoadState =
  | { slug: string; status: "loading" }
  | { slug: string; status: "ready"; project: Project }
  | { slug: string; status: "missing" }
  | { slug: string; status: "error"; message: string }

type ProjectView = TaskView | "files"

const VIEWS = [
  { value: "list" as const, label: "List" },
  { value: "board" as const, label: "Board" },
  { value: "files" as const, label: "Files" },
]
const PHONE_VIEWS = VIEWS.filter((option) => option.value !== "board")
const VIEW_VALUES: readonly ProjectView[] = ["list", "board", "files"]

// data-full-bleed asks the shell to drop its padding on desktop, --chat-space keeps the chat button clear
const FRAME = "flex flex-col lg:grid lg:h-full lg:grid-cols-[minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]"
const COLUMN =
  "flex min-w-0 flex-col gap-3.5 max-lg:pb-14 lg:min-h-0 lg:overflow-y-auto lg:pb-[max(1.5rem,var(--chat-space,0rem))] lg:pl-6 lg:pt-6"

const LOAD_FAILED = "Check your connection and try again."

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

export default function ProjectPage() {
  const { slug = "" } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [state, setState] = useState<LoadState>({ slug, status: "loading" })
  const [attempt, setAttempt] = useState(0)
  const latest = useRef(state)
  latest.current = state

  useEffect(() => {
    if (latest.current.slug === slug && latest.current.status === "ready") return
    let cancelled = false
    setState({ slug, status: "loading" })
    projectsAPI.getProjectBySlug(slug).then(
      (project) => {
        if (!cancelled) setState({ slug, status: "ready", project })
      },
      (err: unknown) => {
        if (cancelled) return
        const missing = err instanceof ApiError && [400, 403, 404].includes(err.status)
        setState(missing ? { slug, status: "missing" } : { slug, status: "error", message: messageOf(err, LOAD_FAILED) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [slug, attempt])

  const changeProject = useCallback(
    (next: Project) => {
      setState({ slug: next.slug, status: "ready", project: next })
      if (next.slug !== slug) navigate({ pathname: `/project/${next.slug}`, search: location.search }, { replace: true })
    },
    [slug, navigate, location.search],
  )

  const markMissing = useCallback(() => setState({ slug, status: "missing" }), [slug])

  // Until the new slug has loaded, the previous project's view must not see the new URL
  const current: LoadState = state.slug === slug ? state : { slug, status: "loading" }
  useDocumentTitle(current.status === "ready" ? current.project.name : "Projects")

  if (current.status === "missing") {
    return (
      <NotFoundView title="This project wandered off" text="It may have been deleted, or you don't have access to it.">
        <Button asChild variant="outline" size="sm">
          <Link to="/projects">Projects</Link>
        </Button>
      </NotFoundView>
    )
  }

  if (current.status === "error") {
    return (
      <EmptyPage
        alert
        icon={<Warning aria-hidden="true" weight="fill" className="size-[1.25rem] text-app-berry" />}
        title="Couldn't load the project"
        text={current.message}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        }
      />
    )
  }

  if (current.status === "loading") return <PageSkeleton />

  return <ProjectView key={current.project.id} project={current.project} onProjectChange={changeProject} onMissing={markMissing} />
}

function ProjectView({
  project,
  onProjectChange,
  onMissing,
}: {
  project: Project
  onProjectChange: (project: Project) => void
  onMissing: () => void
}) {
  const navigate = useNavigate()
  const desktop = useIsDesktop()
  const { projects } = useProjects()
  const listed = projects.find((item) => item.id === project.id)
  const pinned = !!listed?.pinned
  // A workspace admin outside the project reads it until they join
  const readOnly = project.member === false
  const [joining, setJoining] = useState(false)
  useEffect(() => rememberProject(project.id), [project.id])
  // A change refused because the caller left the project reloads it, which turns the page read-only or not found
  useEffect(() => {
    let live = true
    const recheck = () => {
      projectsAPI.getProjectBySlug(project.slug).then(
        (fresh) => {
          if (!live || fresh.member === project.member) return
          onProjectChange(fresh)
          notifyProjectsChanged()
        },
        (err: unknown) => {
          if (live && err instanceof ApiError && err.status === 404) onMissing()
        },
      )
    }
    window.addEventListener(PROJECT_READ_ONLY_EVENT, recheck)
    return () => {
      live = false
      window.removeEventListener(PROJECT_READ_ONLY_EVENT, recheck)
    }
  }, [project.slug, project.member, onProjectChange, onMissing])
  // Losing access while the page is open looks the same as opening a project the user is not in
  const load = useCallback(
    () =>
      tasksAPI.getProjectTasks(project.id).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) onMissing()
        throw err
      }),
    [project.id, onMissing],
  )
  const { tasks, status, error, source, reload, updateTask, addTask, removeTask } = useTaskList(load, `project:${project.id}`)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const filterRef = useRef<HTMLButtonElement>(null)
  const createdId = useRef<string | null>(null)
  const { openTask, panelOpen, shown, selectedId, setSelectedId, setTaskParam, openPanel, closePanel, step, closeAfterDelete } =
    useTaskPanelRoute({ tasks, status, heading: headingRef })
  const viewKey = `nerla-project-view:${project.id}`
  const [view, setView] = useState<ProjectView>(() => readViewPreference(viewKey, "list", VIEW_VALUES))
  const [params, setParams] = useSearchParams()
  const folderId = params.get("folder")
  const [groupBy, setGroupBy] = useState<TaskGroupBy>("status")
  const [filters, setFilters] = useState<TaskFilters>(NO_FILTERS)
  const [creating, setCreating] = useState<TaskStatus | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [picker, setPicker] = useState<{ taskId: string; picker: TaskPanelPicker } | null>(null)

  const people = useMemo(() => {
    const byId = new Map(project.members.map((member) => [member.id, member]))
    for (const task of tasks) {
      if (task.assignee && !byId.has(task.assignee.id)) byId.set(task.assignee.id, task.assignee)
    }
    return [...byId.values()].sort((a, b) => userName(a).localeCompare(userName(b), undefined, { sensitivity: "base" }))
  }, [project.members, tasks])

  const filtered = useMemo(() => filterTasks(tasks, filters), [tasks, filters])
  const filesView = view === "files"
  const shownView: ProjectView = desktop || view !== "board" ? view : "list"
  const effectiveView: TaskView = desktop && view === "board" ? "board" : "list"
  const listActive = effectiveView === "list" && !filesView
  const order = useMemo(() => groupTasks(filtered, groupBy).flatMap((group) => group.tasks), [filtered, groupBy])
  const selectedTask = order.find((task) => task.id === selectedId)
  const loadFailed = status === "error" && tasks.length === 0
  const panelTask = desktop ? openTask : shown
  const target = openTask ?? (listActive ? selectedTask : undefined)

  const close = () => {
    setPicker(null)
    closePanel()
  }

  const move = (direction: 1 | -1) => {
    setPicker(null)
    step(order, direction)
  }

  const pick = (kind: TaskPanelPicker) => {
    if (!target || (kind === "assignee" && target.project_id === null)) return
    setSelectedId(target.id)
    if (openTask?.id !== target.id) setTaskParam(target.id)
    setPicker({ taskId: target.id, picker: kind })
  }

  const deletePanelTask = async () => {
    const task = panelTask
    if (!task) return
    const next = neighborOf(order, task.id)
    const entry = await tasksAPI.deleteTask(task.id)
    removeTask(task.id)
    setPicker(null)
    closeAfterDelete(next)
    movedToTrash("Task moved to the trash", entry, (restored) => {
      if (restored.kind === "task" && restored.task.project_id === project.id) addTask(restored.task)
      notifyTasksChanged(source)
    })
  }

  const changeProject = (next: Project) => {
    const identifiersChanged =
      next.key !== project.key || next.name !== project.name || next.color !== project.color || next.icon !== project.icon
    onProjectChange(next)
    if (identifiersChanged) void reload()
  }

  const startCreate = (next: TaskStatus) => {
    if (readOnly) return
    createdId.current = null
    setCreating(next)
  }

  const join = async () => {
    setJoining(true)
    try {
      const { joined_as, ...joined } = await projectsAPI.joinProject(project.slug)
      onProjectChange(joined)
      notifyProjectsChanged()
      toast.success(joined_as === "admin" ? `You joined ${project.name} as its admin` : `You joined ${project.name}`)
    } catch (err) {
      toast.error(messageOf(err, "Couldn't join the project. Try again."))
    } finally {
      setJoining(false)
    }
  }

  // When the button that opened the new task dialog is gone, focus lands on the new task or the heading
  const focusAfterCreate = () => {
    const row = findTaskRow(createdId.current)
    createdId.current = null
    return row ?? headingRef.current
  }

  const clearFilters = () => {
    setFilters(NO_FILTERS)
    filterRef.current?.focus()
  }

  const changeView = (next: ProjectView) => {
    setView(next)
    saveViewPreference(viewKey, next)
  }

  const openFolder = useCallback(
    (next: string | null, place?: FilePlace) => {
      // A folder found by search somewhere else opens on the Files page
      if (place && !(place.section === "project" && place.projectId === project.id)) {
        navigate(filesPath(place))
        return
      }
      setParams((current) => {
        const kept = new URLSearchParams(current)
        if (next) kept.set("folder", next)
        else kept.delete("folder")
        return kept
      })
    },
    [setParams, navigate, project.id],
  )

  // The Files view has its own keys, so only closing an open task stays live there
  const changes = !readOnly
  useTaskShortcuts(
    filesView
      ? { close: panelOpen ? close : undefined }
      : {
          new: changes ? () => startCreate("todo") : undefined,
          next: listActive ? () => move(1) : undefined,
          prev: listActive ? () => move(-1) : undefined,
          open: listActive && selectedTask ? () => openPanel(selectedTask) : undefined,
          close: panelOpen ? close : undefined,
          status: changes && target ? () => pick("status") : undefined,
          priority: changes && target ? () => pick("priority") : undefined,
          assignee: changes && target && target.project_id !== null ? () => pick("assignee") : undefined,
        },
  )

  const togglePin = () => {
    if (!listed) return
    setProjectPinned(listed, !pinned).catch(() => {
      toast.error(pinned ? `Couldn't unpin ${project.name}` : `Couldn't pin ${project.name}`)
    })
  }

  const commands: Command[] = changes
    ? [{ id: "task-new", title: "New task", group: "Actions", shortcut: "C", keywords: ["create", "add"], run: () => startCreate("todo") }]
    : [{ id: "project-join", title: "Join project", group: "Actions", keywords: ["join", "member"], run: () => void join() }]
  if (listed) {
    commands.push({
      id: "project-pin",
      title: pinned ? "Unpin from sidebar" : "Pin to sidebar",
      group: "Actions",
      keywords: ["pin", "sidebar"],
      run: togglePin,
    })
  }
  if (target && changes) {
    commands.push(
      { id: "task-status", title: "Change status", group: "Actions", shortcut: "S", run: () => pick("status") },
      { id: "task-priority", title: "Change priority", group: "Actions", shortcut: "P", run: () => pick("priority") },
    )
    if (target.project_id !== null) {
      commands.push({
        id: "task-assign",
        title: "Assign",
        group: "Actions",
        shortcut: "A",
        keywords: ["assignee"],
        run: () => pick("assignee"),
      })
    }
  }
  useRegisterCommands(commands)

  const taskCount = status === "ready" || tasks.length > 0 ? tasks.length : project.task_count
  const inline = desktop && panelOpen
  const dock = usePresence(inline)
  // The column stays while the panel eases out
  const docked = dock.mounted

  const headerButtons = (className: string) => (
    <>
      {listed && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={pinned ? "Unpin from sidebar" : "Pin to sidebar"}
          title={pinned ? "Unpin from sidebar" : "Pin to sidebar"}
          onClick={togglePin}
          className={cn("text-muted-foreground hover:text-foreground", className)}
        >
          <Pin aria-hidden="true" weight={pinned ? "fill" : "regular"} className="size-[1.125rem]" />
        </Button>
      )}
      {changes && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Project settings"
          onClick={() => setSettingsOpen(true)}
          className={cn("text-muted-foreground hover:text-foreground", className)}
        >
          <Settings aria-hidden="true" className="size-[1.125rem]" />
        </Button>
      )}
    </>
  )

  const panel = (
    <TaskPanel
      task={panelTask}
      members={project.members}
      projects={projects}
      onClose={close}
      onUpdate={(patch) => (panelTask ? updateTask(panelTask.id, patch, { quiet: true }) : Promise.resolve(null))}
      onDelete={deletePanelTask}
      pickerOpen={picker && picker.taskId === panelTask?.id ? picker.picker : null}
      onPickerOpenChange={(next) => setPicker(next && panelTask ? { taskId: panelTask.id, picker: next } : null)}
      readOnly={readOnly}
    />
  )

  return (
    <div data-full-bleed="" className={cn(FRAME, docked && "lg:grid-cols-[minmax(0,1fr)_23rem]")}>
      <div className={cn(COLUMN, docked ? "lg:pr-5" : "lg:pr-6")}>
        <PageHeader
          titleRef={headingRef}
          title={
            <>
              <IdentityTile color={project.color} symbol={project.icon} size="md" />
              <span className="min-w-0 truncate">{project.name}</span>
            </>
          }
          meta={
            <>
              {plural(taskCount, "task")} · {plural(project.members.length, "member")}
              {project.chat_id && (
                <>
                  {" · "}
                  <Link
                    to={`/messages?group=${project.chat_id}`}
                    className="rounded-sm text-muted-foreground underline-offset-[0.2em] transition-colors duration-150 hover:text-foreground hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
                  >
                    Project chat
                  </Link>
                </>
              )}
            </>
          }
          actions={
            desktop &&
            changes && (
              <>
                {headerButtons("max-lg:hidden")}
                <Button type="button" shortcut={filesView ? undefined : "C"} onClick={() => startCreate("todo")}>
                  New task
                </Button>
              </>
            )
          }
        />
        {!desktop && changes && <CreateFab label="New task" shortcut={filesView ? undefined : "c"} onClick={() => startCreate("todo")} />}
        {changes && <FirstTip id="project" />}
        {readOnly && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-app-sunk py-1.5 pr-1.5 pl-3 text-ui text-foreground">
            <span className="min-w-0 flex-1">You're viewing as an admin. Join to make changes.</span>
            <Button type="button" size="sm" disabled={joining} aria-busy={joining || undefined} onClick={() => void join()}>
              {joining ? "Joining" : "Join project"}
            </Button>
          </div>
        )}

        {filesView && (
          <section aria-labelledby="project-files" className="flex min-w-0 flex-col gap-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="project-files" className="sr-only">
                Files
              </h2>
              <SegmentedControl
                label="View"
                value={shownView}
                onChange={changeView}
                options={desktop ? VIEWS : PHONE_VIEWS}
                className="ml-auto"
              />
              {headerButtons("lg:hidden")}
            </div>
            <FileBrowser
              key={readOnly ? "read-only" : "member"}
              place={{ section: "project", projectId: project.id, folderId }}
              rootLabel={project.name}
              onOpenFolder={openFolder}
              embedded
              readOnly={readOnly}
            />
          </section>
        )}

        <section aria-labelledby="project-tasks" hidden={filesView} className="flex min-w-0 flex-col gap-3.5">
          <h2 id="project-tasks" className="sr-only">
            Tasks
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <TaskFilterMenu ref={filterRef} filters={filters} people={people} onChange={setFilters} />
            {listActive && <GroupSelect value={groupBy} onChange={setGroupBy} />}
            <SegmentedControl
              label="View"
              value={shownView}
              onChange={changeView}
              options={desktop ? VIEWS : PHONE_VIEWS}
              className="ml-auto"
            />
            {headerButtons("lg:hidden")}
          </div>

          <TaskErrorBar error={error} hidden={loadFailed} />

          <div data-task-nav="">
            {status === "loading" ? (
              <TasksSkeleton view={effectiveView} />
            ) : loadFailed ? (
              <TasksPlaceholder role="alert" text={error ?? "Couldn't load tasks."} action="Try again" onAction={reload} />
            ) : tasks.length === 0 ? (
              changes ? (
                <TasksPlaceholder art={<CatNapping />} text="All caught up" action="New task" onAction={() => startCreate("todo")} />
              ) : (
                <TasksPlaceholder art={<CatNapping />} text="All caught up" />
              )
            ) : filtered.length === 0 ? (
              <TasksPlaceholder text="No tasks match these filters" action="Clear filters" onAction={clearFilters} />
            ) : listActive ? (
              <TaskList
                tasks={filtered}
                groupBy={groupBy}
                onOpen={openPanel}
                onAdd={changes ? (next) => startCreate(next ?? "todo") : undefined}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            ) : (
              <TaskBoard
                tasks={filtered}
                onOpen={openPanel}
                onMove={changes ? (id, next) => void updateTask(id, { status: next }) : undefined}
                onAdd={changes ? startCreate : undefined}
                selectedId={openTask?.id ?? null}
              />
            )}
          </div>
        </section>
      </div>

      {desktop ? (
        docked && <TaskPanelDock presence={dock}>{panel}</TaskPanelDock>
      ) : (
        <TaskPanelSheet
          open={panelOpen}
          onOpenChange={(open) => !open && close()}
          label={shown ? [shown.identifier, shown.title].filter(Boolean).join(" ") : "Task"}
        >
          {panel}
        </TaskPanelSheet>
      )}

      <NewTaskDialog
        open={creating !== null}
        onOpenChange={(open) => !open && setCreating(null)}
        defaultProjectId={project.id}
        defaultStatus={creating ?? "todo"}
        onCreated={(task) => {
          if (task.project_id !== project.id) return
          addTask(task)
          createdId.current = task.id
        }}
        fallbackFocus={focusAfterCreate}
        source={source}
      />

      <ProjectSettingsDialog
        project={project}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onChanged={changeProject}
        onDeleted={() => setSettingsOpen(false)}
        fallbackFocus={() => headingRef.current}
      />
    </div>
  )
}

function EmptyPage({
  icon,
  title,
  text,
  action,
  alert = false,
}: {
  icon: ReactNode
  title: string
  text: string
  action: ReactNode
  alert?: boolean
}) {
  return (
    <div role={alert ? "alert" : undefined} className="mx-auto flex max-w-[24rem] flex-col items-center gap-2 px-4 py-20 text-center">
      <span className="mb-1.5 flex size-[2.5rem] items-center justify-center rounded-lg bg-app-sunk text-muted-foreground">{icon}</span>
      <h1 className="text-title font-semibold tracking-[-0.01em] text-foreground">{title}</h1>
      <p className="text-body text-muted-foreground">{text}</p>
      <div className="mt-2.5">{action}</div>
    </div>
  )
}

function PageSkeleton() {
  return (
    <div data-full-bleed="" className={FRAME}>
      <div className={cn(COLUMN, "lg:pr-6")}>
        <div aria-hidden="true" className="flex flex-col gap-2 pt-0.5">
          <Skeleton className="h-[1.9rem] w-[16rem] max-w-full" />
          <Skeleton className="h-[1.1rem] w-[12rem] max-w-full" />
        </div>
        <div aria-hidden="true" className="flex gap-2">
          <Skeleton className="h-[1.75rem] w-[4.5rem] rounded-md" />
          <Skeleton className="h-[1.75rem] w-[7rem] rounded-md" />
        </div>
        <TasksSkeleton view="list" label="Loading project" />
      </div>
    </div>
  )
}
