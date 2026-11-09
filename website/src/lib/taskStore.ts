import { useCallback, useEffect, useId, useRef, useState } from "react"
import { toast } from "sonner"
import { ApiError } from "@/lib/api/request"
import { tasksAPI } from "@/lib/api/tasks"
import type { Task, TaskPatch } from "@/lib/api/tasks"
import { parseServerDate } from "@/lib/dates"
import { onSocketReconnect, onTasksPushed } from "@/lib/socket"

export type TaskListStatus = "loading" | "ready" | "error"

const TASKS_CHANGED_EVENT = "nerla:tasks-changed"
const RELOAD_WINDOW_MS = 300
// A save that changes these can move the task out of the list that made it, so that list reloads too
const MEMBERSHIP_FIELDS: readonly (keyof TaskPatch)[] = ["project_id", "assigned_to"]

export const SAVE_FAILED = "Couldn't save the change. Check your connection and try again."
const LOAD_FAILED = "Couldn't load tasks. Check your connection and try again."

type FieldSeq = Partial<Record<keyof TaskPatch, number>>
type TaskChanges = { pending: { seq: number; patch: TaskPatch }[]; latest: FieldSeq; confirmed: FieldSeq }

// The list that made a change already holds the server copy, so it passes its source and skips its own reload
export function notifyTasksChanged(source?: string) {
  window.dispatchEvent(new CustomEvent<{ source?: string }>(TASKS_CHANGED_EVENT, { detail: { source } }))
}

export function applyTaskPatch(tasks: Task[], id: string, patch: TaskPatch): Task[] {
  return tasks.map((task) => (task.id === id ? { ...task, ...patch } : task))
}

function fieldsOf(patch: TaskPatch) {
  return Object.keys(patch) as (keyof TaskPatch)[]
}

function withPending(task: Task, inFlight: Map<string, TaskChanges>): Task {
  const changes = inFlight.get(task.id)
  if (!changes) return task
  const overlay: TaskPatch = {}
  for (const { seq, patch } of changes.pending) {
    for (const field of fieldsOf(patch)) {
      if (seq > (changes.confirmed[field] ?? 0)) Object.assign(overlay, { [field]: patch[field] })
    }
  }
  return { ...task, ...overlay }
}

function stampOf(task: Task): number {
  return parseServerDate(task.updated_at)?.getTime() ?? 0
}

// A reload or save that answers late must not bring back an older copy than the one shown
function newestCopy(incoming: Task, shown: Task | undefined): Task {
  return shown && stampOf(shown) > stampOf(incoming) ? shown : incoming
}

/** "2 project files stayed in Brand refresh", after a task left the project they belong to */
const stayedText = (count: number, project: string) => `${count} project ${count === 1 ? "file" : "files"} stayed in ${project}`

/** Only 4xx messages are written for users, server faults and network failures get the fallback */
export function messageOf(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError) || err.status <= 0 || err.status >= 500) return fallback
  return err.serverMessage ?? fallback
}

export function useTaskList(load: () => Promise<Task[]>, key: string) {
  const [listKey, setListKey] = useState(key)
  const [tasks, setTasks] = useState<Task[]>([])
  const [status, setStatus] = useState<TaskListStatus>("loading")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  if (listKey !== key) {
    setListKey(key)
    setTasks([])
    setStatus("loading")
    setLoadError(null)
    setSaveError(null)
  }

  const source = useId()
  const loadRef = useRef(load)
  loadRef.current = load
  const keyRef = useRef(key)
  keyRef.current = key
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const requestId = useRef(0)
  const inFlight = useRef(new Map<string, TaskChanges>())
  const nextSeq = useRef(0)

  const reload = useCallback(async () => {
    const id = ++requestId.current
    try {
      const next = await loadRef.current()
      if (id !== requestId.current) return
      setTasks((current) => {
        const shown = new Map(current.map((task) => [task.id, task]))
        return next.map((task) => withPending(newestCopy(task, shown.get(task.id)), inFlight.current))
      })
      setStatus("ready")
      setLoadError(null)
    } catch (err) {
      if (id !== requestId.current) return
      setStatus("error")
      setLoadError(messageOf(err, LOAD_FAILED))
    }
  }, [])

  useEffect(() => {
    reload()
  }, [key, reload])

  // A burst of changes and focus events within the window becomes one reload
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void reload()
      }, RELOAD_WINDOW_MS)
    }
    const onTasksChanged = (event: Event) => {
      if ((event as CustomEvent<{ source?: string } | null>).detail?.source !== source) schedule()
    }
    window.addEventListener("focus", schedule)
    window.addEventListener(TASKS_CHANGED_EVENT, onTasksChanged)
    const offPushed = onTasksPushed(schedule)
    const offReconnect = onSocketReconnect(schedule)
    return () => {
      offPushed()
      offReconnect()
      clearTimeout(timer)
      window.removeEventListener("focus", schedule)
      window.removeEventListener(TASKS_CHANGED_EVENT, onTasksChanged)
    }
  }, [reload, source])

  const updateTask = useCallback(
    async (id: string, patch: TaskPatch, { quiet = false }: { quiet?: boolean } = {}): Promise<string | null> => {
      const seq = ++nextSeq.current
      const previous = tasksRef.current.find((task) => task.id === id)
      const startKey = keyRef.current
      const fields = fieldsOf(patch)
      const changes = inFlight.current.get(id) ?? { pending: [], latest: {}, confirmed: {} }
      changes.pending.push({ seq, patch })
      for (const field of fields) changes.latest[field] = seq
      inFlight.current.set(id, changes)

      const settle = () => {
        changes.pending = changes.pending.filter((change) => change.seq !== seq)
        if (changes.pending.length === 0) inFlight.current.delete(id)
      }

      if (!quiet) setSaveError(null)
      setTasks((current) => applyTaskPatch(current, id, patch))
      try {
        const { unlinkedFiles = 0, ...saved } = await tasksAPI.updateTask(id, patch)
        for (const field of fields) changes.confirmed[field] = Math.max(changes.confirmed[field] ?? 0, seq)
        settle()
        if (unlinkedFiles > 0 && previous?.project) toast(stayedText(unlinkedFiles, previous.project.name))
        notifyTasksChanged(fields.some((field) => MEMBERSHIP_FIELDS.includes(field)) ? undefined : source)
        if (keyRef.current !== startKey) return null
        setTasks((current) => current.map((task) => (task.id === id ? withPending(newestCopy(saved, task), inFlight.current) : task)))
        return null
      } catch (err) {
        settle()
        const message = messageOf(err, SAVE_FAILED)
        if (keyRef.current !== startKey) return message
        const ours = fields.filter((field) => changes.latest[field] === seq)
        if (previous && ours.length > 0) {
          const restore: TaskPatch = Object.fromEntries(ours.map((field) => [field, previous[field]]))
          setTasks((current) => applyTaskPatch(current, id, restore))
        }
        if (!quiet) setSaveError(message)
        await reload()
        return message
      }
    },
    [reload, source],
  )

  // NewTaskDialog announces the new task itself, with this list as its source
  const addTask = useCallback((task: Task) => {
    setTasks((current) => [task, ...current.filter((t) => t.id !== task.id)])
  }, [])

  const removeTask = useCallback(
    (id: string) => {
      setTasks((current) => current.filter((task) => task.id !== id))
      notifyTasksChanged(source)
    },
    [source],
  )

  return { tasks, status, error: saveError ?? loadError, source, reload, updateTask, addTask, removeTask }
}
