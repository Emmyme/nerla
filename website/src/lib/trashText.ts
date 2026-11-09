import type { TrashFilterKey, TrashItem, TrashKind } from "@/lib/api/trash"
import { parseServerDate, startOfDay } from "@/lib/dates"

const DAY_MS = 86_400_000

export const KIND_FILTERS: { key: TrashFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "files", label: "Files" },
  { key: "docs", label: "Papers and boards" },
  { key: "tasks", label: "Tasks" },
  { key: "events", label: "Events" },
  { key: "projects", label: "Projects" },
]

export const trashFilterOf = (value: string | null): TrashFilterKey => KIND_FILTERS.find((filter) => filter.key === value)?.key ?? "all"

const calendarDays = (from: Date, to: Date) => Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS)

/** "Deleted 3 days ago by Theo", "Deleted today by you", by the local calendar day */
export function deletedLine(
  item: { deletedAt: string; deletedBy: { id?: string; name: string } | null },
  now: Date,
  viewerId?: string | null,
): string {
  const at = parseServerDate(item.deletedAt) ?? now
  const days = Math.max(0, calendarDays(at, now))
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`
  if (!item.deletedBy?.name) return `Deleted ${when}`
  return `Deleted ${when} by ${viewerId && item.deletedBy.id === viewerId ? "you" : item.deletedBy.name}`
}

/** "Deleted for good in 27 days", "Deleted for good tomorrow" or "Deleted for good today" */
export function leftLine(purgeAt: string, now: Date): string {
  const left = (parseServerDate(purgeAt)?.getTime() ?? now.getTime()) - now.getTime()
  if (left < DAY_MS) return "Deleted for good today"
  const days = Math.round(left / DAY_MS)
  return days <= 1 ? "Deleted for good tomorrow" : `Deleted for good in ${days} days`
}

export const KIND_NAMES: Record<TrashKind, string> = {
  file: "File",
  folder: "Folder",
  paper: "Paper",
  board: "Board",
  task: "Task",
  event: "Event",
  project: "Project",
}

/** Where an item lived. Events and projects always say "own", so they show no place */
export function placeLine(item: Pick<TrashItem, "kind" | "where">): string | null {
  if (item.kind === "event" || item.kind === "project") return null
  if (item.where.kind === "project") return `In ${item.where.name}`
  if (item.where.kind === "folder") return `In the folder ${item.where.name}`
  return item.kind === "task" ? "Personal" : "In My files"
}

/** Where a restore puts it back, for "Restored to Website" */
export function restoredTo(item: Pick<TrashItem, "kind" | "where">): string {
  if (item.kind === "event") return "Calendar"
  if (item.kind === "project") return "Projects"
  if (item.where.kind !== "own" && item.where.name) return item.where.name
  return item.kind === "task" ? "My tasks" : "My files"
}

export const EMPTY_TEXT: Record<TrashFilterKey, string> = {
  all: "The trash is empty. Tidy!",
  files: "No files or folders in the trash.",
  docs: "No papers or boards in the trash.",
  tasks: "No tasks in the trash.",
  events: "No events in the trash.",
  projects: "No projects in the trash.",
}
