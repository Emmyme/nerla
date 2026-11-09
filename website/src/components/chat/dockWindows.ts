import type { ChatKind } from "@/lib/api/chat"

/** Only what finds the chat again. Titles and names stay out of storage. The AI's DM is the kind `ai` with the id `ai` */
export type DockEntry = { kind: ChatKind | "ai"; id: string; minimized: boolean }

export const AI_DOCK = { kind: "ai", id: "ai" } as const

export const MAX_WINDOWS = 3

export const dockStorageKey = (userId: string) => `nerla-dock:${userId}`

/** Signing out leaves nothing of the user's windows behind */
export function clearDock(userId: string) {
  try {
    localStorage.removeItem(dockStorageKey(userId))
  } catch {
    return
  }
}

export const entryKey = (entry: Pick<DockEntry, "kind" | "id">) => `${entry.kind}:${entry.id.toLowerCase()}`

/** Oldest first. The chat opened becomes the newest, so it is always in view, and one past the limit replaces the oldest. */
export function openWindow(list: DockEntry[], entry: Pick<DockEntry, "kind" | "id">, max = MAX_WINDOWS): DockEntry[] {
  const key = entryKey(entry)
  const rest = list.filter((w) => entryKey(w) !== key)
  return [...rest, { kind: entry.kind, id: entry.id.toLowerCase(), minimized: false }].slice(-max)
}

/**
 * Windows for groups the list no longer has, as after leaving one, and the AI's while it is unavailable to the user.
 * A DM may simply have no messages yet.
 */
export function pruneWindows(list: DockEntry[], listed: Set<string>, keep: Set<string>, aiThere = true): DockEntry[] {
  const next = list.filter((w) => (w.kind === "ai" ? aiThere : w.kind !== "group" || listed.has(entryKey(w)) || keep.has(entryKey(w))))
  return next.length === list.length ? list : next
}

export function closeWindow(list: DockEntry[], key: string): DockEntry[] {
  return list.filter((w) => entryKey(w) !== key)
}

export function setMinimized(list: DockEntry[], key: string, minimized: boolean): DockEntry[] {
  return list.map((w) => (entryKey(w) === key && w.minimized !== minimized ? { ...w, minimized } : w))
}

/** What was saved, or nothing when it is missing or invalid */
export function parseDock(raw: string | null): DockEntry[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const valid = parsed.filter(
      (w): w is DockEntry =>
        !!w &&
        (w.kind === "dm" || w.kind === "group" || (w.kind === "ai" && w.id === AI_DOCK.id)) &&
        typeof w.id === "string" &&
        w.id !== "" &&
        typeof w.minimized === "boolean",
    )
    return valid
      .map(({ kind, id, minimized }) => ({ kind, id: id.toLowerCase(), minimized }))
      .filter((w, i, all) => all.findIndex((other) => entryKey(other) === entryKey(w)) === i)
      .slice(-MAX_WINDOWS)
  } catch {
    return []
  }
}
