import type { Via } from "./aiTypes"
import { serverInstant } from "./chatAccess"
import type { EventChange } from "./eventNotice"

/** On by default, for the bell and for desktop pop-ups */
const INVOLVES_YOU = [
  "project_added",
  "task_assigned",
  "mentioned",
  "comment_on_my_task",
  "my_task_changed",
  "doc_shared",
  "doc_comment",
  "ai_pending",
  "event_changed",
] as const
/** Off by default */
const EVERYTHING = ["project_task_added", "project_task_changed", "project_task_completed", "project_comment"] as const
export const NOTIFICATION_KINDS = [...INVOLVES_YOU, ...EVERYTHING] as const

export type Kind = (typeof NOTIFICATION_KINDS)[number]
export type KindPref = { bell: boolean; desktop: boolean }
export type Prefs = Partial<Record<Kind, Partial<KindPref>>>

/** When one event matches several kinds for one user, the first of these wins */
const PRECEDENCE: Kind[] = [
  "mentioned",
  "doc_shared",
  "doc_comment",
  "event_changed",
  "ai_pending",
  "task_assigned",
  "comment_on_my_task",
  "my_task_changed",
  "project_added",
  "project_task_added",
  "project_task_completed",
  "project_task_changed",
  "project_comment",
]

const GROUPED: ReadonlySet<Kind> = new Set([
  "my_task_changed",
  "project_task_added",
  "project_task_changed",
  "project_task_completed",
  "event_changed",
])
const GROUP_WINDOW_MS = 10 * 60 * 1000

export type NotificationEvent =
  | { type: "project_added"; actorId: string; projectId: string; userIds: string[] }
  | { type: "task_added"; actorId: string; taskId: string }
  | {
      type: "task_changed"
      actorId: string
      taskId: string
      assigned: boolean
      statusOrDue: boolean
      completed: boolean
      /** How many of the fields that notify changed */
      changes: number
    }
  | { type: "comment"; actorId: string; taskId: string; commentId: string; mentions: string[]; edited: boolean }
  | { type: "message"; actorId: string; messageId: string; mentions: string[] }
  | { type: "doc_shared"; actorId: string; fileId: string; userIds: string[] }
  /** Users newly mentioned in a paper's text */
  | { type: "doc_mention"; actorId: string; fileId: string; userIds: string[] }
  /**
   * A comment on a paper or board, or a reply in one of its threads. An edit only tells the users it newly mentions.
   * A guest in a call has no id
   */
  | { type: "doc_comment"; actorId: string | null; fileId: string; commentId: string; mentions: string[]; edited: boolean }
  /** An outside agent's change waits for the asker's Allow */
  | { type: "ai_pending"; actorId: null; userId: string; heldId: string }
  /** A user invited others to an event, or moved, cancelled or restored one. `userIds` are the users to tell */
  | {
      type: "event_changed"
      actorId: string
      eventId: string
      change: EventChange
      startsAt: string
      allDay: boolean
      userIds: string[]
      organiserId?: string
      via?: Via | null
    }

export type Relation =
  "assignee" | "creator" | "project_member" | "chat_member" | "grantee" | "doc_owner" | "thread_member" | "guest" | "organiser"

export type Candidate = {
  userId: string
  isActor: boolean
  relations: Relation[]
  /** Whether they can open the place right now */
  canSee: boolean
  /** Mentioned, and allowed to be mentioned there */
  mentioned: boolean
  prefs: Prefs
}

export type Recipient = { userId: string; kind: Kind } & KindPref

const isDefaultOn = (kind: Kind) => (INVOLVES_YOU as readonly Kind[]).includes(kind)

function prefFor(prefs: Prefs, kind: Kind): KindPref {
  const on = isDefaultOn(kind)
  return { bell: prefs[kind]?.bell ?? on, desktop: prefs[kind]?.desktop ?? on }
}

export function resolvePrefs(prefs: Prefs): Record<Kind, KindPref> {
  return Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, prefFor(prefs, kind)])) as Record<Kind, KindPref>
}

function matchedKinds(event: NotificationEvent, candidate: Candidate): Kind[] {
  const has = (relation: Relation) => candidate.relations.includes(relation)
  const kinds: (Kind | false)[] = []
  switch (event.type) {
    case "project_added":
      kinds.push(has("project_member") && "project_added")
      break
    case "task_added":
      kinds.push(has("assignee") && "task_assigned", has("project_member") && "project_task_added")
      break
    case "task_changed":
      kinds.push(
        event.assigned && has("assignee") && "task_assigned",
        event.statusOrDue && has("assignee") && "my_task_changed",
        has("project_member") && (event.completed ? "project_task_completed" : "project_task_changed"),
      )
      break
    case "comment":
      kinds.push(candidate.mentioned && "mentioned")
      if (!event.edited) {
        kinds.push((has("assignee") || has("creator")) && "comment_on_my_task", has("project_member") && "project_comment")
      }
      break
    case "message":
      kinds.push(candidate.mentioned && has("chat_member") && "mentioned")
      break
    case "doc_shared":
      kinds.push(has("grantee") && "doc_shared")
      break
    case "doc_mention":
      kinds.push(candidate.mentioned && "mentioned")
      break
    case "doc_comment":
      kinds.push(candidate.mentioned && "mentioned")
      if (!event.edited) kinds.push((has("doc_owner") || has("thread_member")) && "doc_comment")
      break
    case "ai_pending":
      kinds.push("ai_pending")
      break
    case "event_changed":
      kinds.push((has("guest") || has("organiser")) && "event_changed")
      break
  }
  return kinds.filter((kind): kind is Kind => !!kind)
}

/**
 * One entry per user: never the actor and never a user who can't see the place. Each channel is chosen along the
 * precedence order, so a kind with the bell off still lets a less specific kind fill the bell
 */
export function recipientsFor(event: NotificationEvent, candidates: Candidate[]): Recipient[] {
  const seen = new Set<string>()
  const out: Recipient[] = []
  for (const candidate of candidates) {
    if (candidate.isActor || !candidate.canSee || seen.has(candidate.userId)) continue
    seen.add(candidate.userId)
    const matched = new Set(matchedKinds(event, candidate))
    const ordered = PRECEDENCE.filter((kind) => matched.has(kind)).map((kind) => ({ kind, ...prefFor(candidate.prefs, kind) }))
    const desktop = ordered.some((pref) => pref.desktop)
    // The bell gets the most specific kind with the bell on. With none, a pop-up alone shows the most specific desktop kind
    const shown = ordered.find((pref) => pref.bell) ?? ordered.find((pref) => pref.desktop)
    if (shown) out.push({ userId: candidate.userId, kind: shown.kind, bell: shown.bell, desktop })
  }
  return out
}

/** The key a mention from a paper's comment carries, so the bell tells it from a mention in the text */
export const DOC_COMMENT_KEY = "doc_comment:"

/** The key of the notice for one waiting card, so it goes when the card closes */
export const aiPendingKey = (heldId: string) => `ai_pending:${heldId}`

/**
 * Task changes by one user to one task share a key per kind, as do changes by one user to one event. A mention in a
 * paper's comment is keyed by its comment, so mentioning a user again in it soon after adds no second entry. Everything
 * else stands alone
 */
export function groupKey(event: NotificationEvent, kind: Kind): string | null {
  if (event.type === "doc_comment" && kind === "mentioned") return `${DOC_COMMENT_KEY}${event.commentId}`
  if (event.type === "ai_pending") return aiPendingKey(event.heldId)
  if (!GROUPED.has(kind)) return null
  // An invite keeps its own entry, so a move soon after never hides it
  if (event.type === "event_changed") return `${kind}:${event.actorId}:${event.eventId}${event.change === "invited" ? ":invited" : ""}`
  if (!("taskId" in event)) return null
  return `${kind}:${event.actorId}:${event.taskId}`
}

/** What one event adds to an entry's change count */
export const changesIn = (event: NotificationEvent): number => (event.type === "task_changed" ? event.changes : 1)

export function shouldGroup(
  existing: { groupKey: string | null; updatedAt: string },
  next: { groupKey: string | null },
  now: Date,
): boolean {
  if (!existing.groupKey || existing.groupKey !== next.groupKey) return false
  const age = now.getTime() - serverInstant(existing.updatedAt)
  return age >= 0 && age < GROUP_WINDOW_MS
}
