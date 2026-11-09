import { useCallback, useEffect, useState, type RefObject } from "react"
import { useSearchParams } from "react-router"
import type { Task } from "@/lib/api/tasks"
import type { TaskListStatus } from "@/lib/taskStore"

export function findTaskRow(id: string | null): HTMLElement | null {
  return id ? document.querySelector<HTMLElement>(`[data-task-id="${id}"]`) : null
}

// Focus moves only once the closing panel has left, or after a second at most
const PANEL_GONE_WAIT_MS = 1000

function focusWhenPanelGone(target: () => HTMLElement | null) {
  const started = performance.now()
  const check = () => {
    if (document.querySelector("[data-task-panel]") && performance.now() - started < PANEL_GONE_WAIT_MS) {
      requestAnimationFrame(check)
      return
    }
    const active = document.activeElement
    if (!active || active === document.body) target()?.focus()
  }
  requestAnimationFrame(check)
}

const REST_MS = 250
let lastStepAt = -Infinity

// Holding J or K must not load every task it passes, so panel loads wait until the steps have rested
export function whenSelectionRests(run: () => void): () => void {
  const check = () => {
    const wait = lastStepAt + REST_MS - performance.now()
    if (wait > 0) timer = setTimeout(check, wait)
    else run()
  }
  let timer = setTimeout(check, 0)
  return () => clearTimeout(timer)
}

export function neighborOf(order: Task[], id: string): Task | undefined {
  const index = order.findIndex((task) => task.id === id)
  return index === -1 ? undefined : (order[index + 1] ?? order[index - 1])
}

// The open task lives in ?task=<id> so links to a task open it, and the list selection follows it
export function useTaskPanelRoute({
  tasks,
  status,
  heading,
}: {
  tasks: Task[]
  status: TaskListStatus
  heading: RefObject<HTMLElement | null>
}) {
  const [params, setParams] = useSearchParams()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [shown, setShown] = useState<Task | null>(null)
  const [syncedOpenId, setSyncedOpenId] = useState<string | null>(null)

  const openId = params.get("task")
  const openTask = openId ? (tasks.find((task) => task.id === openId) ?? null) : null
  const panelOpen = openTask !== null
  if (openTask && openTask !== shown) setShown(openTask)
  if (openId !== syncedOpenId && (openTask || !openId)) {
    setSyncedOpenId(openId)
    if (openId) setSelectedId(openId)
  }

  const setTaskParam = useCallback(
    (id: string | null) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (id) next.set("task", id)
          else next.delete("task")
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  // The open task can leave the list, for example when it is reassigned or moved, so the panel closes
  const shownId = shown?.id
  useEffect(() => {
    if (!openId || status !== "ready" || tasks.some((task) => task.id === openId)) return
    setTaskParam(null)
    if (shownId === openId) focusWhenPanelGone(() => heading.current)
  }, [openId, status, tasks, setTaskParam, shownId, heading])

  const openPanel = useCallback(
    (task: Task) => {
      setSelectedId(task.id)
      setTaskParam(task.id)
    },
    [setTaskParam],
  )

  const closePanel = () => {
    const id = selectedId
    setTaskParam(null)
    focusWhenPanelGone(() => findTaskRow(id) ?? heading.current)
  }

  const step = (order: Task[], direction: 1 | -1) => {
    if (order.length === 0) return
    const index = order.findIndex((task) => task.id === selectedId)
    const next =
      index === -1 ? order[direction > 0 ? 0 : order.length - 1] : order[Math.min(Math.max(index + direction, 0), order.length - 1)]
    if (next.id !== selectedId) lastStepAt = performance.now()
    setSelectedId(next.id)
    if (panelOpen) setTaskParam(next.id)
  }

  const closeAfterDelete = (next: Task | undefined) => {
    setSelectedId(next?.id ?? null)
    setTaskParam(null)
    focusWhenPanelGone(() => findTaskRow(next?.id ?? null) ?? heading.current)
  }

  return {
    openId,
    openTask,
    panelOpen,
    shown,
    selectedId,
    setSelectedId,
    setTaskParam,
    openPanel,
    closePanel,
    step,
    closeAfterDelete,
  }
}
