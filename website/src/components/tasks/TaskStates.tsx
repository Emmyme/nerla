import { useState, type ReactNode } from "react"
import { Warning } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export type TaskView = "board" | "list"

const BOARD_TINTS = ["bg-app-col-todo", "bg-app-col-progress", "bg-app-col-done"]

export function TasksPlaceholder({
  art,
  text,
  action,
  onAction,
  role,
}: {
  art?: ReactNode
  text: string
  action?: string
  onAction?: () => void
  role?: "alert"
}) {
  return (
    <div role={role} className="flex flex-col items-center gap-3 rounded-xl px-4 py-10 text-center ring-[0.0625rem] ring-border">
      {art}
      <p className="text-body font-semibold text-foreground">{text}</p>
      {action && onAction && (
        <Button type="button" variant="outline" size="sm" onClick={onAction}>
          {action}
        </Button>
      )}
    </div>
  )
}

export function TasksSkeleton({ view, label = "Loading tasks" }: { view: TaskView; label?: string }) {
  return (
    <div>
      <span role="status" className="sr-only">
        {label}
      </span>
      {view === "board" ? (
        <div aria-hidden="true" className="grid grid-cols-3 gap-2.5">
          {BOARD_TINTS.map((tint) => (
            <div key={tint} className={cn("flex flex-col gap-2 rounded-xl p-2", tint)}>
              <div className="px-1.5 py-1">
                <Skeleton className="h-[0.9rem] w-[5rem] bg-card" />
              </div>
              <div className="h-[4.75rem] rounded-lg bg-card ring-[0.0625rem] ring-border" />
              <div className="h-[4.75rem] rounded-lg bg-card ring-[0.0625rem] ring-border" />
            </div>
          ))}
        </div>
      ) : (
        <div aria-hidden="true" className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-[2.4rem] rounded-lg" />
          ))}
        </div>
      )}
    </div>
  )
}

// A dismissed message stays hidden until the store reports a different one
export function TaskErrorBar({ error, hidden = false, className }: { error: string | null; hidden?: boolean; className?: string }) {
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (error === null && dismissed !== null) setDismissed(null)
  if (error === null || error === dismissed || hidden) return null

  return (
    <div
      role="alert"
      className={cn("flex items-center gap-2.5 rounded-lg border-[0.0625rem] border-border bg-card py-1 pr-1 pl-3 text-ui", className)}
    >
      <Warning aria-hidden="true" weight="fill" className="size-[1rem] shrink-0 text-app-berry" />
      <span className="min-w-0 flex-1 text-app-berry-text">{error}</span>
      <Button type="button" variant="ghost" size="sm" onClick={() => setDismissed(error)}>
        Dismiss
      </Button>
    </div>
  )
}
