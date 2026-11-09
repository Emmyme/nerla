import { addDays, startOfDay, startOfWeek } from "@/lib/dates"
import type { PresenceState, StatusOverride } from "@/lib/presence"

export type StatusOption = StatusOverride | "auto"
export type ClearAfter = "30m" | "1h" | "2h" | "today" | "week" | "never"

export const STATUS_OPTIONS: { value: StatusOption; label: string; cat: PresenceState | null }[] = [
  { value: "auto", label: "Automatic", cat: null },
  { value: "available", label: "Available", cat: "available" },
  { value: "busy", label: "Busy", cat: "busy" },
  { value: "dnd", label: "Do not disturb", cat: "dnd" },
  { value: "away", label: "Away", cat: "away" },
  { value: "ooo", label: "Out of office", cat: "ooo" },
  { value: "secret", label: "That's a secret", cat: "secret" },
  { value: "offline", label: "Appear offline", cat: "offline" },
]

export const CLEAR_OPTIONS: { value: ClearAfter; label: string }[] = [
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "2h", label: "2 hours" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "never", label: "Don't clear" },
]

const MINUTE = 60_000

export function defaultClearAfter(status: StatusOption): ClearAfter {
  return status === "busy" || status === "dnd" || status === "ooo" || status === "secret" ? "today" : "never"
}

/** When a status set now should end, as an ISO instant, or null to keep it. Today and this week end at 23:59. */
export function clearAt(option: ClearAfter, now: Date): string | null {
  switch (option) {
    case "30m":
      return new Date(now.getTime() + 30 * MINUTE).toISOString()
    case "1h":
      return new Date(now.getTime() + 60 * MINUTE).toISOString()
    case "2h":
      return new Date(now.getTime() + 120 * MINUTE).toISOString()
    case "today":
      return new Date(startOfDay(addDays(now, 1)).getTime() - MINUTE).toISOString()
    case "week":
      return new Date(addDays(startOfWeek(now), 7).getTime() - MINUTE).toISOString()
    case "never":
      return null
  }
}

/** The option an end time came from, when it can still be told from the time alone */
export function clearAfterOf(until: string | null, now: Date): ClearAfter | null {
  if (until === null) return "never"
  if (until === clearAt("today", now)) return "today"
  if (until === clearAt("week", now)) return "week"
  return null
}
