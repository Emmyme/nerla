import { get, post, put, patch, del } from "@/lib/api/request"
import type { Via } from "@/lib/api/ai"

export type TimeProjectRef = { id: string; name: string; color: string | null }
export type TimeTaskRef = { id: string; identifier: string | null; title: string }

/** One of the user's own entries. A deleted place keeps only its name */
export interface TimeEntry {
  id: string
  date: string
  minutes: number
  note: string | null
  source: "manual" | "suggestion" | "timer" | "auto"
  project: TimeProjectRef | null
  deletedProjectName: string | null
  task: TimeTaskRef | null
  taskLabel: string | null
  locked: boolean
  needsCheck: boolean
  auto: boolean
  edited: boolean
  /** Made through the user's agent or AI */
  done_via?: Via | null
}

export interface TimerDto {
  startedAt: string
  project: TimeProjectRef | null
  task: TimeTaskRef | null
  note: string | null
}

type TimeStateDto =
  { enabled: false } | { enabled: true; timer: TimerDto | null; autofillProjectId: string | null; canReport: boolean; checks: TimeEntry[] }

/** Where time goes. A task's own project wins over `projectId` */
export type TimePlace = { projectId?: string; taskId?: string }

export type TimeEntryCreate = TimePlace & {
  date: string
  minutes: number
  note?: string | null
  source: "manual" | "suggestion"
  suggestionKey?: string
}

export type TimeEntryPatch = { date?: string; minutes?: number; note?: string | null; projectId?: string; taskId?: string | null }

type TimerStart = { timer: TimerDto; stopped: TimeEntry | null; stoppedLocked?: true }

export interface TimeSuggestion {
  key: string
  kind: "meeting" | "task" | "repeat"
  date: string
  minutes: number
  title: string
  project: TimeProjectRef | null
  task: TimeTaskRef | null
  needsProject: boolean
}

export interface TimeWeek {
  start: string
  days: { date: string; entries: TimeEntry[]; suggestions: TimeSuggestion[]; minutes: number }[]
  minutes: number
  /** Lock dates by project id. The date itself is locked */
  lockedUntil: Record<string, string>
}

export type TimeGroupBy = "person" | "project" | "task"
export type TimeReportFilters = { from: string; to: string; people?: string[]; projects?: string[]; groupBy?: TimeGroupBy }
export type TimePerson = { id: string; name: string; email: string }

export interface TimeReportEntry {
  id: string
  date: string
  minutes: number
  note: string | null
  source: TimeEntry["source"]
  person: TimePerson
  project: TimeProjectRef | null
  deletedProjectName: string | null
  task: TimeTaskRef | null
  taskLabel: string | null
}

export type TimeLock = { projectId: string; name: string; lockedUntil: string | null }

export interface TimeReport {
  minutes: number
  groups: { id: string; label: string; minutes: number }[]
  /** At most 2000, with `truncated` set when more matched. The totals cover everything */
  entries: TimeReportEntry[]
  truncated: boolean
  lockable: TimeLock[]
  options: { people: TimePerson[]; projects: TimeProjectRef[] }
}

/** `minutes` is everything on the place and `lockedMinutes` the part a delete keeps. Null for anyone but its admins */
export type TimeImpact = { minutes: number | null; lockedMinutes: number | null }

function reportQuery(filters: TimeReportFilters): string {
  const query = new URLSearchParams({ from: filters.from, to: filters.to })
  if (filters.people?.length) query.set("people", filters.people.join(","))
  if (filters.projects?.length) query.set("projects", filters.projects.join(","))
  if (filters.groupBy) query.set("groupBy", filters.groupBy)
  return query.toString()
}

/** Everything but `state` answers 404 while the workspace has time tracking off */
export const timeAPI = {
  state: (): Promise<TimeStateDto> => get("/time/state"),
  checksSeen: (ids: string[]): Promise<{ message: string }> => post("/time/checks/seen", { ids }),

  createEntry: (body: TimeEntryCreate): Promise<{ entry: TimeEntry }> => post("/time/entries", body),
  updateEntry: (id: string, changes: TimeEntryPatch): Promise<{ entry: TimeEntry }> => patch(`/time/entries/${id}`, changes),
  deleteEntry: (id: string): Promise<{ message: string }> => del(`/time/entries/${id}`),

  /** Starting while a timer runs stops and logs that one first */
  startTimer: (body: TimePlace & { note?: string | null }): Promise<TimerStart> => post("/time/timer", body),
  stopTimer: (): Promise<{ entry: TimeEntry | null; locked?: true }> => post("/time/timer/stop"),

  /** The user's minutes on a task, and its total for the project's admins and workspace admins */
  task: (taskId: string, signal?: AbortSignal): Promise<{ mine: number; total: number | null }> => get(`/time/tasks/${taskId}`, { signal }),
  saveSettings: (autofillProjectId: string | null): Promise<{ autofillProjectId: string | null }> =>
    put("/time/settings", { autofillProjectId }),

  /** `start` is a Monday */
  week: (start: string, signal?: AbortSignal): Promise<TimeWeek> => get(`/time/week?start=${start}`, { signal }),
  dismiss: (key: string): Promise<{ message: string }> => post("/time/dismissals", { key }),

  report: (filters: TimeReportFilters, signal?: AbortSignal): Promise<TimeReport> =>
    get(`/time/reports?${reportQuery(filters)}`, { signal }),
  reportCsv: (filters: TimeReportFilters): Promise<Blob> =>
    get(`/time/reports.csv?${reportQuery(filters)}`, { responseType: "blob", timeoutMs: 120000 }),
  /** Saves the report as a CSV file */
  downloadReportCsv: async (filters: TimeReportFilters): Promise<void> => {
    const url = URL.createObjectURL(await timeAPI.reportCsv(filters))
    const link = document.createElement("a")
    link.href = url
    link.download = `time-${filters.from}-${filters.to}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  },

  locks: (): Promise<TimeLock[]> => get("/time/locks"),
  /** An earlier date or null unlocks */
  setLocks: (projectIds: string[] | "all", until: string | null): Promise<TimeLock[]> => put("/time/locks", { projectIds, until }),

  impact: (place: { projectId: string } | { taskId: string }): Promise<TimeImpact> =>
    get(`/time/impact?${"projectId" in place ? `projectId=${place.projectId}` : `taskId=${place.taskId}`}`),
}
