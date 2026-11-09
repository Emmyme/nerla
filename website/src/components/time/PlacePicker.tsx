import { useEffect, useState } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { tasksAPI } from "@/lib/api/tasks"
import type { TimePlace, TimeProjectRef, TimeTaskRef } from "@/lib/api/time"
import { useProjects } from "@/lib/useProjects"

/** A project id or "personal", and a task in it. A personal one needs its task */
export type PlaceChoice = { project: string | null; task: string | null }

export const PERSONAL = "personal"
const NO_TASK = "none"
const LABEL = "text-caption font-medium text-muted-foreground"

type TaskOption = { id: string; label: string }

/** "WEB-12 Fix login", or the title alone for a task without an identifier */
export const taskLabel = (task: { identifier: string | null; title: string }) =>
  task.identifier ? `${task.identifier} ${task.title}` : task.title

export function choiceOf(entry: { project: TimeProjectRef | null; task: TimeTaskRef | null }): PlaceChoice {
  return { project: entry.project?.id ?? (entry.task ? PERSONAL : null), task: entry.task?.id ?? null }
}

/** The place to send, or null while a personal task is still to be picked */
export function placeOf(choice: PlaceChoice): TimePlace | null {
  if (!choice.project) return null
  if (choice.project === PERSONAL) return choice.task ? { taskId: choice.task } : null
  return choice.task ? { projectId: choice.project, taskId: choice.task } : { projectId: choice.project }
}

/** The member projects or a personal task, then a task loaded for that choice in one request */
export function PlacePicker({
  value,
  onChange,
  known,
  idPrefix,
  error,
}: {
  value: PlaceChoice
  onChange: (value: PlaceChoice) => void
  /** The entry's own project and task, listed while they load or when the project is archived */
  known?: { project: TimeProjectRef | null; task: TimeTaskRef | null }
  idPrefix: string
  error?: string | null
}) {
  const { projects } = useProjects()
  const [tasks, setTasks] = useState<{ for: string; options: TaskOption[] } | null>(null)
  const [failed, setFailed] = useState(false)
  const chosen = value.project

  useEffect(() => {
    if (!chosen) return
    let live = true
    setFailed(false)
    const load =
      chosen === PERSONAL ? tasksAPI.getUserTasks().then((all) => all.filter((task) => !task.project_id)) : tasksAPI.getProjectTasks(chosen)
    load.then(
      (found) => live && setTasks({ for: chosen, options: found.map((task) => ({ id: task.id, label: taskLabel(task) })) }),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [chosen])

  const shownProjects = projects
    .filter((project) => project.member !== false && (project.status !== "archived" || project.id === chosen))
    .map((project) => ({ id: project.id, name: project.name }))
  const knownProject = known?.project
  if (knownProject && !shownProjects.some((project) => project.id === knownProject.id)) shownProjects.unshift(knownProject)

  const loaded = tasks?.for === chosen ? tasks.options : []
  const knownTask = known?.task
  const taskOptions =
    knownTask && value.task === knownTask.id && !loaded.some((task) => task.id === knownTask.id)
      ? [{ id: knownTask.id, label: taskLabel(knownTask) }, ...loaded]
      : loaded
  const personal = chosen === PERSONAL

  return (
    <>
      <div className="flex flex-col gap-1">
        <span id={`${idPrefix}-project`} className={LABEL}>
          Project
        </span>
        <Select value={chosen ?? undefined} onValueChange={(project) => onChange({ project, task: null })}>
          <SelectTrigger aria-labelledby={`${idPrefix}-project`} aria-invalid={!chosen && !!error ? true : undefined}>
            <SelectValue placeholder="Pick a project" />
          </SelectTrigger>
          <SelectContent>
            {shownProjects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
            <SelectItem value={PERSONAL}>Personal task</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {chosen && (
        <div className="flex flex-col gap-1">
          <span id={`${idPrefix}-task`} className={LABEL}>
            Task
          </span>
          <Select
            value={value.task ?? (personal ? undefined : NO_TASK)}
            onValueChange={(task) => onChange({ project: chosen, task: task === NO_TASK ? null : task })}
          >
            <SelectTrigger
              aria-labelledby={`${idPrefix}-task`}
              aria-busy={tasks?.for !== chosen && !failed ? true : undefined}
              aria-invalid={personal && !value.task && !!error ? true : undefined}
            >
              <SelectValue placeholder={failed ? "Couldn't load tasks" : "Pick a task"} />
            </SelectTrigger>
            <SelectContent className="max-w-[min(24rem,calc(100vw-2rem))]">
              {!personal && <SelectItem value={NO_TASK}>No task</SelectItem>}
              {taskOptions.map((task) => (
                <SelectItem key={task.id} value={task.id}>
                  {task.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {error && (
        <p role="alert" className="text-caption text-app-berry-text">
          {error}
        </p>
      )}
    </>
  )
}
