import { readViewPreference, saveViewPreference } from "@/lib/viewPreference"

const KEY = "nerla-board-backlog-open"
const VALUES = ["open", "folded"] as const

export function readBacklogOpen(): boolean {
  return readViewPreference(KEY, "folded", VALUES) === "open"
}

export function saveBacklogOpen(open: boolean): void {
  saveViewPreference(KEY, open ? "open" : "folded")
}
