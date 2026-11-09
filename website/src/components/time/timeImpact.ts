import { useEffect, useState } from "react"
import { timeAPI, type TimeImpact } from "@/lib/api/time"
import { formatMinutes } from "@/lib/timeFormat"
import { useTimeTracking } from "@/lib/timeStore"

type Place = { projectId: string } | { taskId: string }

const KEPT = "stays while it's in the trash and goes when it's deleted for good."

/** What deleting a place does to logged time, said only while time tracking is on. Time goes only with the purge */
function impactText(impact: TimeImpact, kind: "task" | "project"): string | null {
  if (impact.minutes === null) return `Time logged on this ${kind} ${KEPT}`
  const locked = impact.lockedMinutes ?? 0
  const gone = impact.minutes - locked
  const parts = [gone > 0 ? `Its ${formatMinutes(gone)} of logged time ${KEPT}` : null, locked > 0 ? "Locked hours stay in reports." : null]
  return parts.filter(Boolean).join(" ") || null
}

/** Asks once, when a delete confirm opens. `place` is null while it is closed */
export function useTimeImpactText(place: Place | null, kind: "task" | "project"): string | null {
  const { enabled } = useTimeTracking()
  const [impact, setImpact] = useState<{ key: string; value: TimeImpact } | null>(null)
  const byProject = !!place && "projectId" in place
  const key = place ? ("projectId" in place ? place.projectId : place.taskId) : null

  useEffect(() => {
    if (!enabled || !key) return
    let live = true
    timeAPI.impact(byProject ? { projectId: key } : { taskId: key }).then(
      (value) => live && setImpact({ key, value }),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [enabled, key, byProject])

  if (!enabled || !key || impact?.key !== key) return null
  return impactText(impact.value, kind)
}
