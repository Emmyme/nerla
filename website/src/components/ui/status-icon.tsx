import { cn } from "@/lib/utils"
import type { TaskStatus } from "@/types/tasks"

const STATUS: Record<TaskStatus, { label: string; color: string }> = {
  backlog: { label: "Backlog", color: "var(--color-status-backlog)" },
  todo: { label: "To do", color: "var(--color-status-todo)" },
  in_progress: { label: "In progress", color: "var(--color-status-progress)" },
  done: { label: "Done", color: "var(--color-status-done)" },
}

export function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const { label, color } = STATUS[status] ?? STATUS.todo
  return (
    <svg viewBox="0 0 16 16" role="img" aria-label={label} className={cn("h-4 w-4 shrink-0", className)} fill="none">
      {status === "done" ? (
        <>
          <circle cx="8" cy="8" r="6.85" fill={color} />
          {/* The surface colour is white in light mode and stays legible on the paler dark mode green */}
          <path
            d="M5.3 8.2 7.2 10.1 10.8 6.3"
            stroke="var(--color-surface)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <circle
          cx="8"
          cy="8"
          r="6"
          stroke={color}
          strokeWidth="1.7"
          strokeDasharray={status === "backlog" ? "1.6 3.11" : undefined}
          strokeLinecap={status === "backlog" ? "round" : undefined}
        />
      )}
      {status === "in_progress" && <path d="M8 4.2 A3.8 3.8 0 0 1 8 11.8 Z" fill={color} />}
    </svg>
  )
}
