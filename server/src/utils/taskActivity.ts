const DIFFED_FIELDS = ["status", "priority", "assignee", "due_date", "project"] as const

/** `trash` rows say "trashed" or "restored" */
export const ACTIVITY_FIELDS = [...DIFFED_FIELDS, "trash"] as const

type ActivityField = (typeof DIFFED_FIELDS)[number]

export type ActivitySource = {
  status: string
  priority: string
  assignedTo: string | null
  dueDate: string | null
  projectId: string | null
}

type ActivityChange = {
  field: ActivityField
  from: string | null
  to: string | null
}

const toDay = (value: string | null): string | null => (value ? value.slice(0, 10) : null)

const activityValues = (source: ActivitySource): Record<ActivityField, string | null> => ({
  status: source.status,
  priority: source.priority,
  assignee: source.assignedTo,
  due_date: toDay(source.dueDate),
  project: source.projectId,
})

export function diffTaskActivity(before: ActivitySource, after: ActivitySource): ActivityChange[] {
  const from = activityValues(before)
  const to = activityValues(after)

  return DIFFED_FIELDS.filter((field) => from[field] !== to[field]).map((field) => ({ field, from: from[field], to: to[field] }))
}

type TaskText = { title: string; description: string | null }

/** The full old and new title and description, recorded only for edits made through an agent or the AI */
export function diffTaskText(
  before: TaskText,
  after: TaskText,
): { field: "title" | "description"; from: string | null; to: string | null }[] {
  return (["title", "description"] as const)
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, from: before[field], to: after[field] }))
}

export function activityLabel(
  field: string,
  value: string | null,
  names: { users: Map<string, string>; projects: Map<string, string> },
): string | null {
  if (field === "assignee") {
    return value ? names.users.get(value) || null : null
  }
  if (field === "project") {
    return value ? (names.projects.get(value) ?? "another project") : "Personal"
  }
  return value
}
