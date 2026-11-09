import { useEffect, useState } from "react"
import { Link } from "react-router"
import { Stop, Timer } from "@/components/icons"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { TimerDto } from "@/lib/api/time"
import { parseServerDate } from "@/lib/dates"
import { formatClock } from "@/lib/timeFormat"
import { stopTimer, useTimeTracking } from "@/lib/timeStore"
import { cn } from "@/lib/utils"

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

/** What the timer runs on: the task's identifier, or its title for a personal task, or the project */
const timerPlace = (timer: TimerDto) => timer.task?.identifier || timer.task?.title || timer.project?.name || "Timer"

/** Ticks here once a second, with no request */
function useElapsed(startedAt: string): string {
  const start = parseServerDate(startedAt)?.getTime() ?? Date.now()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return formatClock(now - start)
}

/** The running timer, for the sidebar (`row`), its collapsed rail (`rail`) and the phone's More sheet (`sheet`) */
export function TimerClock({ variant = "row" }: { variant?: "row" | "rail" | "sheet" }) {
  const { timer } = useTimeTracking()
  if (!timer) return null
  return <RunningClock key={timer.startedAt} timer={timer} variant={variant} />
}

function RunningClock({ timer, variant }: { timer: TimerDto; variant: "row" | "rail" | "sheet" }) {
  const elapsed = useElapsed(timer.startedAt)
  const [stopping, setStopping] = useState(false)
  const place = timerPlace(timer)

  if (variant === "rail") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/time"
            aria-label={`Timer on ${place}`}
            className={`mx-auto flex size-8 items-center justify-center rounded-md bg-app-sky-soft text-app-sky-ink hover:bg-app-sky ${focusRing}`}
          >
            <Timer aria-hidden="true" size={17} weight="bold" />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          <span className="tabular-nums">{elapsed}</span>, {place}
        </TooltipContent>
      </Tooltip>
    )
  }

  const stop = async () => {
    if (stopping) return
    setStopping(true)
    await stopTimer()
    setStopping(false)
  }

  const sheet = variant === "sheet"
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md bg-app-sky-soft text-app-sky-ink",
        sheet ? "min-h-11 py-1 pr-1 pl-3" : "h-8 py-1 pr-1 pl-2.75",
      )}
    >
      <Timer aria-hidden="true" size={sheet ? 20 : 17} weight="bold" className="shrink-0" />
      <span role="timer" className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="sr-only">Timer on {place}, </span>
        <span className="shrink-0 text-ui font-medium tabular-nums">{elapsed}</span>
        <span aria-hidden="true" title={place} className="min-w-0 truncate text-caption font-medium">
          {place}
        </span>
      </span>
      <button
        type="button"
        aria-label="Stop timer"
        title="Stop timer"
        disabled={stopping}
        onClick={() => void stop()}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-md hover:bg-app-sky disabled:opacity-50",
          sheet ? "size-11" : "size-6",
          focusRing,
        )}
      >
        <Stop aria-hidden="true" weight="fill" className={sheet ? "size-[1.1rem]" : "size-3.5"} />
      </button>
    </div>
  )
}
