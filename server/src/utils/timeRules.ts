import { isValidTimeZone, storedMs, wallClock } from "./eventTime"

/** Minutes since local midnight */
export type Span = { start: number; end: number }

export const MAX_TIMER_MINUTES = 600

type SeenEntry = { userId: string; projectId: string | null; taskId: string | null; detached: boolean }
type EditedEntry = SeenEntry & { date: string }

/** The YYYY-MM-DD an instant falls on in the user's zone, in UTC when they have none */
export function localDate(instant: Date, timeZone: string | null): string {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC"
  return new Date(wallClock(instant.getTime(), zone)).toISOString().slice(0, 10)
}

/**
 * Lock dates are inclusive, and time on personal tasks is never billed so never locked. A detached entry was kept
 * because it was locked, and stays so
 */
export function isLocked(entry: { projectId: string | null; date: string; detached?: boolean }, lockedUntil: string | null): boolean {
  if (entry.detached) return true
  return entry.projectId !== null && lockedUntil !== null && entry.date <= lockedUntil
}

export function canSeeEntry(entry: SeenEntry, viewer: { userId: string; isOrgAdmin: boolean; adminProjectIds: Set<string> }): boolean {
  if (entry.userId === viewer.userId) return true
  if (entry.detached) return viewer.isOrgAdmin
  if (!entry.projectId) return false
  return viewer.isOrgAdmin || viewer.adminProjectIds.has(entry.projectId)
}

/** Only the owner changes an entry, while it and where it moves to are unlocked and they are still in its project */
export function canEditEntry(
  entry: EditedEntry,
  viewer: { userId: string; memberProjectIds: Set<string> },
  lockedUntil: string | null,
  target?: { date: string; lockedUntil: string | null },
): "ok" | "hidden" | "locked" | "read-only" {
  if (entry.userId !== viewer.userId) return "hidden"
  if (isLocked(entry, lockedUntil)) return "locked"
  if (target && target.lockedUntil !== null && target.date <= target.lockedUntil) return "locked"
  if (entry.detached || (entry.projectId && !viewer.memberProjectIds.has(entry.projectId))) return "read-only"
  return "ok"
}

/** Minutes of `window` that none of `spans` cover */
function uncovered(window: Span, spans: Span[]): number {
  let free = 0
  let cursor = window.start
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const start = Math.max(span.start, cursor)
    if (start >= window.end) break
    if (span.end <= start) continue
    free += start - cursor
    cursor = Math.min(span.end, window.end)
  }
  return free + Math.max(0, window.end - cursor)
}

/** The working window minus breaks and time away, counted once where they overlap, minus time logged elsewhere */
export function autoFillMinutes(day: { window: Span | null; breaks: Span[]; away: Span[]; otherMinutes: number }): number {
  if (!day.window || day.window.end <= day.window.start) return 0
  return Math.max(0, uncovered(day.window, [...day.breaks, ...day.away]) - day.otherMinutes)
}

/** Whole minutes a timer ran, capped at `MAX_TIMER_MINUTES` */
export function capTimer(startedAt: string, now: Date): { minutes: number; capped: boolean } {
  const started = storedMs(startedAt) ?? now.getTime()
  const minutes = Math.max(0, Math.floor((now.getTime() - started) / 60_000))
  return minutes > MAX_TIMER_MINUTES ? { minutes: MAX_TIMER_MINUTES, capped: true } : { minutes, capped: false }
}

export type SuggestionCandidate = {
  key: string
  kind: "meeting" | "task" | "repeat"
  date: string
  projectId: string | null
  taskId: string | null
}

/**
 * One day's suggestions that still say something: none dismissed, used, or after today, no task already logged that
 * day, and no repeat of a project, or of a personal task, that already has time that day
 */
export function pickSuggestions<T extends SuggestionCandidate>(
  candidates: T[],
  seen: { dismissed: Set<string>; usedKeys: Set<string>; loggedTaskIds: Set<string>; loggedProjectIds: Set<string>; today: string },
): T[] {
  return candidates.filter((candidate) => {
    if (candidate.date > seen.today || seen.dismissed.has(candidate.key) || seen.usedKeys.has(candidate.key)) return false
    if (candidate.kind === "task") return !(candidate.taskId && seen.loggedTaskIds.has(candidate.taskId))
    if (candidate.kind === "repeat") {
      return candidate.projectId
        ? !seen.loggedProjectIds.has(candidate.projectId)
        : !(candidate.taskId && seen.loggedTaskIds.has(candidate.taskId))
    }
    return true
  })
}

/**
 * A task keeps its name on the user's own time while it sits in that time's project, or while they can still open
 * it. Otherwise its name would tell them about a project they are not in, or about another user's personal task
 */
export function taskNamed(
  task: { projectId: string | null; assignedTo: string | null; isMember: boolean },
  placeProjectId: string | null,
  userId: string,
): boolean {
  if (task.projectId) return task.projectId === placeProjectId || task.isMember
  return task.assignedTo === userId
}

const FORMULA_START = /^[=+\-@\t\r]/

/** One CSV line without its line break. A value a spreadsheet would run as a formula gets a leading quote mark */
export function csvRow(values: string[]): string {
  return values
    .map((value) => {
      const safe = FORMULA_START.test(value) ? `'${value}` : value
      return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
    })
    .join(",")
}
