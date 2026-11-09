import { cn } from "@/lib/utils"
import type { TaskPriority } from "@/types/tasks"

const LABELS: Record<TaskPriority, string> = {
  none: "No priority",
  low: "Low priority",
  medium: "Medium priority",
  high: "High priority",
  urgent: "Urgent",
}

const FILLED: Partial<Record<TaskPriority, number>> = { low: 1, medium: 2, high: 3 }

const BARS = [
  { x: 2, y: 9, height: 5 },
  { x: 6.5, y: 6, height: 8 },
  { x: 11, y: 3, height: 11 },
]

export function PriorityIcon({ priority, className }: { priority: TaskPriority; className?: string }) {
  const filled = FILLED[priority] ?? 0
  return (
    <svg viewBox="0 0 16 16" role="img" aria-label={LABELS[priority]} className={cn("h-4 w-4 shrink-0", className)} fill="none">
      {priority === "urgent" && (
        <>
          <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="var(--color-berry)" />
          <path d="M8 4.6v4.4" stroke="var(--color-surface)" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="8" cy="11.4" r="1" fill="var(--color-surface)" />
        </>
      )}
      {priority === "none" && (
        <path d="M2.5 8h2.5M6.75 8h2.5M11 8h2.5" stroke="var(--color-text-muted)" strokeWidth="1.6" strokeLinecap="round" />
      )}
      {filled > 0 &&
        BARS.map((bar, i) => (
          <rect
            key={bar.x}
            x={bar.x}
            y={bar.y}
            width="3"
            height={bar.height}
            rx="1"
            fill={i < filled ? "var(--color-text)" : "var(--color-priority-off)"}
          />
        ))}
    </svg>
  )
}
