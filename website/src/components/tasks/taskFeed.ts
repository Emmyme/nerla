import type { Task, TaskActivity, TaskComment } from "@/lib/api/tasks"
import type { UserSummary } from "@/lib/api/users"
import { formatShortDate, parseDueDate, parseServerDate } from "@/lib/dates"
import { PRIORITY_LABEL, STATUS_LABEL, type TaskPriority, type TaskStatus } from "@/types/tasks"

type FeedItem =
  | { kind: "created"; key: string; at: string; userId: string | null }
  | { kind: "activity"; key: string; at: string; activity: TaskActivity }
  | { kind: "comment"; key: string; at: string; comment: TaskComment }

export type Segment = { text: string; strong?: boolean }

type Person = Pick<UserSummary, "id" | "first_name" | "last_name">

export function mergeFeed(
  activity: TaskActivity[],
  comments: TaskComment[],
  task: Pick<Task, "id" | "created_at" | "created_by">,
): FeedItem[] {
  const entries: FeedItem[] = [
    ...activity.map((row): FeedItem => ({ kind: "activity", key: `activity:${row.id}`, at: row.created_at, activity: row })),
    ...comments.map((row): FeedItem => ({ kind: "comment", key: `comment:${row.id}`, at: row.created_at, comment: row })),
  ]
  const sorted = entries
    .map((item, index) => ({ item, index, time: parseServerDate(item.at)?.getTime() ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.time === b.time ? a.index - b.index : a.time - b.time))
    .map(({ item }) => item)

  return [{ kind: "created", key: `created:${task.id}`, at: task.created_at, userId: task.created_by }, ...sorted]
}

function firstName(person: Person | null | undefined): string {
  return person?.first_name || person?.last_name || "Someone"
}

export function actorName(person: Person | null | undefined, meId: string | null): string {
  return person && person.id === meId ? "You" : firstName(person)
}

const strong = (text: string): Segment => ({ text, strong: true })
const plain = (text: string): Segment => ({ text })

function statusLabel(value: string | null): string {
  return (value && STATUS_LABEL[value as TaskStatus]) || (value ?? "").replace(/_/g, " ")
}

function priorityLabel(value: string | null): string {
  return (value && PRIORITY_LABEL[value as TaskPriority]) || (value ?? "")
}

function dueLabel(value: string | null): string {
  return formatShortDate(parseDueDate(value)) || (value ?? "")
}

function change(subject: string, from: string | null, to: string, label: (value: string | null) => string): Segment[] {
  if (!from) return [plain(` set ${subject} to `), strong(label(to))]
  return [plain(` changed ${subject} from `), strong(label(from)), plain(" to "), strong(label(to))]
}

export function describeActivity(activity: TaskActivity, meId: string | null): Segment[] {
  const actor = strong(actorName(activity.user, meId))
  const { from_value: from, to_value: to, from_label: fromLabel, to_label: toLabel } = activity

  switch (activity.field) {
    case "status":
      return to ? [actor, ...change("status", from, to, statusLabel)] : [actor, plain(" cleared the status")]
    case "priority":
      if (!to || to === "none") return [actor, plain(" removed the priority")]
      return [actor, ...change("priority", from === "none" ? null : from, to, priorityLabel)]
    case "due_date":
      if (!to) return [actor, plain(" removed the due date")]
      return [actor, ...change("the due date", from, to, dueLabel)]
    case "assignee": {
      const person = (id: string | null, label: string | null) => (id === meId ? "you" : label || "someone")
      if (!to && from && from === activity.user?.id)
        return [actor, plain(actor.text === "You" ? " unassigned yourself" : " unassigned themselves")]
      if (!to) return [actor, plain(" unassigned "), strong(person(from, fromLabel))]
      if (to === activity.user?.id && !from) return [actor, plain(" self-assigned this")]
      if (!from) return [actor, plain(" assigned this to "), strong(person(to, toLabel))]
      return [actor, plain(" reassigned this from "), strong(person(from, fromLabel)), plain(" to "), strong(person(to, toLabel))]
    }
    case "project":
      return [
        actor,
        plain(" moved this from "),
        strong(fromLabel || "another project"),
        plain(" to "),
        strong(toLabel || "another project"),
      ]
    case "title":
      return [actor, plain(" changed the title from "), strong(from ?? ""), plain(" to "), strong(to ?? "")]
    case "description":
      return [actor, plain(" changed the description")]
    case "trash":
      return [actor, plain(to === "restored" ? " restored this" : " moved this to the trash")]
    default:
      return [actor, plain(" updated this task")]
  }
}
