import { formatDue, formatShortDate, parseDueDate } from "@/lib/dates"
import { cn } from "@/lib/utils"

export function DueLabel({ due, done = false, now }: { due: string | null; done?: boolean; now?: Date }) {
  const label = formatDue(due, now)
  if (!label) return null

  const tone = done ? "later" : label.tone
  return (
    <span
      title={`Due ${formatShortDate(parseDueDate(due), now)}`}
      className={cn(
        "text-caption font-medium whitespace-nowrap tabular-nums",
        tone === "overdue" && "text-app-berry-text",
        tone === "today" && "rounded-full bg-app-lemon-soft px-2 py-0.25 text-app-lemon-ink",
        tone !== "overdue" && tone !== "today" && "text-muted-foreground",
      )}
    >
      {label.text}
    </span>
  )
}
