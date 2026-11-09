import { useEffect, useState } from "react"
import { useRegisterCommands } from "@/components/command/registry"
import { Button } from "@/components/ui/button"
import { timeAPI } from "@/lib/api/time"
import type { Task } from "@/lib/api/tasks"
import { formatMinutes } from "@/lib/timeFormat"
import { onTimeChanged, startTimer, stopTimer, useTimeTracking } from "@/lib/timeStore"
import { LogTimePopover } from "./LogTimePopover"

type Totals = { mine: number; total: number | null }

const ACTION = "px-2 max-lg:px-2"

/** The user's time on the task and, for its admins, the total. A read-only panel shows only the line */
export function TaskTimeLine({ task, readOnly }: { task: Pick<Task, "id" | "identifier" | "title" | "project_id">; readOnly: boolean }) {
  const { timer } = useTimeTracking()
  const [totals, setTotals] = useState<Totals | null>(null)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const running = timer?.task?.id === task.id
  const name = task.identifier || task.title

  useEffect(() => onTimeChanged(() => setReload((count) => count + 1)), [])

  useEffect(() => {
    const controller = new AbortController()
    timeAPI.task(task.id, controller.signal).then(
      (next) => {
        setTotals(next)
        setFailed(false)
      },
      () => !controller.signal.aborted && setFailed(true),
    )
    return () => controller.abort()
  }, [task.id, task.project_id, reload])

  const toggle = async () => {
    if (busy) return
    setBusy(true)
    await (running ? stopTimer() : startTimer({ taskId: task.id }))
    setBusy(false)
  }

  useRegisterCommands(
    readOnly || running
      ? []
      : [
          {
            id: "time-start-task",
            title: `Start timer on ${name}`,
            group: "Actions",
            keywords: ["time", "track", "clock"],
            run: () => void toggle(),
          },
        ],
  )

  const parts = totals
    ? [
        totals.mine > 0 ? `${formatMinutes(totals.mine)} by you` : null,
        totals.total ? `${formatMinutes(totals.total)} total` : null,
      ].filter(Boolean)
    : []
  const line = failed ? "Couldn't load time" : !totals ? "" : parts.length ? parts.join(" · ") : "No time logged"

  return (
    <div className="flex min-w-0 flex-col">
      <span
        className={`flex min-h-[1.875rem] min-w-0 items-center tabular-nums max-lg:min-h-11 ${totals && parts.length ? "font-medium text-foreground" : "text-muted-foreground"}`}
      >
        <span className="truncate">{line}</span>
      </span>
      {!readOnly && (
        <div className="-ml-2 flex flex-wrap items-center gap-1">
          <LogTimePopover place={{ taskId: task.id }} onLogged={() => setReload((count) => count + 1)} className={ACTION} />
          <Button type="button" variant="ghost" aria-busy={busy || undefined} onClick={() => void toggle()} className={ACTION}>
            {running ? "Stop timer" : "Start timer"}
          </Button>
        </div>
      )}
    </div>
  )
}
