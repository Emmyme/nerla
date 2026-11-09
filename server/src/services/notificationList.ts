import { and, count, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm"
import {
  aiHeld,
  aiRequests,
  aiTokens,
  calendarEvents,
  db,
  eventAttendees,
  messages,
  notificationPrefs,
  notifications,
  projects,
  taskComments,
  tasks,
  users,
  type Executor,
} from "../db"
import { messagePreview } from "../utils/chatAccess"
import type { Via } from "../utils/aiTypes"
import { canSeeComments } from "../utils/docAccess"
import { dayIn, dayTextIn, whenIn, type EventNoticeDetail } from "../utils/eventNotice"
import { aiPendingKey, DOC_COMMENT_KEY, resolvePrefs, type Kind, type KindPref, type Prefs } from "../utils/notificationRules"
import { presenceName } from "../utils/presence"
import { taskAccessLevel } from "../utils/taskAccess"
import { liveEvent, liveProject, liveTask } from "../utils/trash"
import { dmAllowed, groupAccess } from "./chats"
import { reachableLevel } from "./docs"
import { mentionNames } from "./mentions"
import { callerMembership } from "./projectAccess"
import { personZone } from "./people"
import { UUID } from "../utils/uuid"

type Row = typeof notifications.$inferSelect
type Viewer = { userId: string; organizationId: string; isOrgAdmin: boolean }

type NotificationDto = {
  id: string
  kind: Kind
  actor: { id: string; name: string; avatarUrl: string | null } | null
  title: string
  snippet: string | null
  href: string | null
  changeCount: number
  read: boolean
  createdAt: string
  /** Done by the AI or an agent for the actor */
  via: Via | null
}

const PAGE_SIZE = 30
const NO_ACCESS = "You no longer have access to this"

type ChatMessage = { senderId: string; recipientId: string | null; threadType: string | null; threadId: string | null }

/** The chat of a message as this user knows it: a group by its id, a DM by the other user's id */
export function chatIdFor(message: ChatMessage, userId: string): { kind: "dm" | "group"; id: string } | null {
  if (message.threadType === "group") return message.threadId ? { kind: "group", id: message.threadId } : null
  if (message.threadType || !message.recipientId) return null
  if (message.senderId === userId) return { kind: "dm", id: message.recipientId }
  return message.recipientId === userId ? { kind: "dm", id: message.senderId } : null
}

export async function unreadCount(userId: string, organizationId: string, executor: Executor = db): Promise<number> {
  const [row] = await executor
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.organizationId, organizationId), isNull(notifications.readAt)))
  return Number(row?.n ?? 0)
}

const SERVER_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/

const encodeCursor = (row: { createdAt: string; id: string }) => Buffer.from(`${row.createdAt}|${row.id}`).toString("base64url")

/** The position after which the next page starts, or undefined when the cursor is not one of ours */
export function decodeCursor(cursor: string): { at: string; id: string } | undefined {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|")
  return at && id && SERVER_TIME.test(at) && UUID.test(id) ? { at, id } : undefined
}

export async function listNotifications(viewer: Viewer, after?: { at: string; id: string }) {
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, viewer.userId),
        eq(notifications.organizationId, viewer.organizationId),
        after
          ? or(lt(notifications.createdAt, after.at), and(eq(notifications.createdAt, after.at), lt(notifications.id, after.id)))
          : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(PAGE_SIZE + 1)
  const page = rows.slice(0, PAGE_SIZE)
  return {
    items: await resolveItems(viewer, page),
    unread: await unreadCount(viewer.userId, viewer.organizationId),
    nextCursor: rows.length > PAGE_SIZE ? encodeCursor(page[page.length - 1]) : null,
  }
}

export const unique = <T>(values: (T | null | undefined)[]) => [...new Set(values.filter((value): value is T => value != null))]

const taskLabel = (task: { title: string; number: number | null; project: { key: string | null } | null }) =>
  task.project?.key && task.number ? `${task.project.key}-${task.number}` : task.title

function titleOf(kind: Exclude<Kind, "event_changed">, actor: string, place: string, changes: number): string {
  switch (kind) {
    case "project_added":
      return `${actor} added you to ${place}`
    case "task_assigned":
      return `${actor} assigned you ${place}`
    case "mentioned":
      return `${actor} mentioned you ${place}`
    case "comment_on_my_task":
    case "project_comment":
      return `${actor} commented on ${place}`
    case "project_task_added":
      return `${actor} added ${place}`
    case "project_task_completed":
      return `${actor} completed ${place}`
    case "my_task_changed":
    case "project_task_changed":
      return changes > 1 ? `${actor} changed ${changes} things on ${place}` : `${actor} changed ${place}`
    case "doc_shared":
      return `${actor} shared ${place} with you`
    case "doc_comment":
      return `${actor} commented on ${place}`
    case "ai_pending":
      return `${place} is waiting for your Allow`
  }
}

function eventNotice(actor: string, detail: EventNoticeDetail, zone: string): { title: string; day: string } {
  const day = dayIn(detail.startsAt, zone, detail.allDay)
  switch (detail.change) {
    case "invited":
      return { title: `${actor} invited you to ${detail.title}, ${whenIn(detail.startsAt, zone, detail.allDay)}`, day }
    case "moved":
      return { title: `${actor} moved ${detail.title} to ${whenIn(detail.startsAt, zone, detail.allDay)}`, day }
    case "cancelled":
      return { title: `${actor} cancelled ${detail.title}, ${dayTextIn(detail.startsAt, zone, detail.allDay)}`, day }
    case "restored":
      return { title: `${actor} restored ${detail.title}`, day }
  }
}

const AI_PENDING_HREF = "/settings/ai?tab=pending"

/** The viewer's own waiting cards behind their notices, with the agent that asked */
async function pendingCards(viewer: Viewer, rows: Row[]) {
  const ids = unique(rows.map((row) => (row.kind === "ai_pending" ? row.groupKey?.slice(aiPendingKey("").length) : null)))
  if (ids.length === 0) return new Map<string, { items: unknown[]; tokenName: string | null }>()
  const cards = await db
    .select({ id: aiHeld.id, items: aiHeld.items, tokenName: aiTokens.name })
    .from(aiHeld)
    .leftJoin(aiRequests, and(eq(aiRequests.id, aiHeld.requestId), eq(aiRequests.organizationId, aiHeld.organizationId)))
    .leftJoin(aiTokens, and(eq(aiTokens.id, aiRequests.tokenId), eq(aiTokens.organizationId, aiHeld.organizationId)))
    .where(and(inArray(aiHeld.id, ids), eq(aiHeld.organizationId, viewer.organizationId), eq(aiHeld.userId, viewer.userId)))
  return new Map(cards.map((card) => [card.id, card]))
}

function pendingSnippet(items: unknown[]): string | null {
  const first = (items[0] as { summary?: unknown } | undefined)?.summary
  if (typeof first !== "string") return null
  return items.length > 1 ? `${first} and ${items.length - 1} more` : first
}

/** Titles, snippets and links as the viewer may see them now. A place they can no longer reach shows a neutral line */
export async function resolveItems(viewer: Viewer, rows: Row[]): Promise<NotificationDto[]> {
  const { userId, organizationId } = viewer
  const actorIds = unique(rows.map((row) => row.actorId))
  const taskIds = unique(rows.map((row) => row.taskId))
  const commentIds = unique(rows.map((row) => row.commentId))
  const projectIds = unique(rows.map((row) => row.projectId))
  const messageIds = unique(rows.map((row) => row.messageId))

  const [actors, taskRows, commentRows, projectRows, messageRows] = await Promise.all([
    actorIds.length
      ? db
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, avatarUrl: users.avatarUrl })
          .from(users)
          .where(inArray(users.id, actorIds))
      : [],
    taskIds.length
      ? db.query.tasks.findMany({
          where: and(inArray(tasks.id, taskIds), eq(tasks.organizationId, organizationId), liveTask),
          columns: { id: true, title: true, number: true, projectId: true, assignedTo: true, organizationId: true, deletedAt: true },
          with: { project: { columns: { slug: true, key: true, organizationId: true, deletedAt: true }, with: callerMembership(userId) } },
        })
      : [],
    commentIds.length
      ? db.query.taskComments.findMany({
          where: and(inArray(taskComments.id, commentIds), eq(taskComments.organizationId, organizationId)),
          columns: { id: true, content: true },
        })
      : [],
    projectIds.length
      ? db.query.projects.findMany({
          where: and(inArray(projects.id, projectIds), eq(projects.organizationId, organizationId), liveProject),
          columns: { id: true, name: true, slug: true },
          with: callerMembership(userId),
        })
      : [],
    messageIds.length
      ? db.query.messages.findMany({
          where: and(inArray(messages.id, messageIds), eq(messages.organizationId, organizationId)),
          columns: { id: true, content: true, kind: true, senderId: true, recipientId: true, threadType: true, threadId: true },
        })
      : [],
  ])

  const actorById = new Map(actors.map((a) => [a.id, a]))
  const taskById = new Map(taskRows.map((t) => [t.id, t]))
  const commentById = new Map(commentRows.map((c) => [c.id, c]))
  const projectById = new Map(projectRows.map((p) => [p.id, p]))
  const messageById = new Map(messageRows.map((m) => [m.id, m]))
  const names = await mentionNames(
    organizationId,
    [...commentRows, ...messageRows].map((row) => row.content),
  )
  const cards = await pendingCards(viewer, rows)
  const zone = rows.some((row) => row.detail) ? await personZone(userId) : "UTC"
  const involved = await involvedEvents(viewer, rows)

  // A chat is looked up once however many of its mentions are on the page
  const chats = new Map<string, Promise<{ name: string | null } | null>>()
  const chatOf = (chat: { kind: "dm" | "group"; id: string }) => {
    const key = `${chat.kind}:${chat.id}`
    let found = chats.get(key)
    if (!found) {
      found =
        chat.kind === "group"
          ? groupAccess(organizationId, userId, chat.id).then((access) => (access ? { name: access.chat.name } : null))
          : dmAllowed(organizationId, userId, chat.id).then((allowed) => (allowed ? { name: null } : null))
      chats.set(key, found)
    }
    return found
  }

  return Promise.all(
    rows.map(async (row): Promise<NotificationDto> => {
      const kind = row.kind as Kind
      const person = row.actorId ? actorById.get(row.actorId) : undefined
      const actorName = person ? presenceName(person.firstName, person.lastName) : "Someone"
      const base = {
        id: row.id,
        kind,
        actor: person ? { id: person.id, name: actorName, avatarUrl: person.avatarUrl } : null,
        changeCount: row.changeCount,
        read: row.readAt !== null,
        createdAt: row.createdAt,
        via: null,
      }
      const gone = { ...base, title: NO_ACCESS, snippet: null, href: null }

      if (kind === "event_changed") {
        if (!row.eventId || !row.detail) return gone
        // A cancelled event has lost its guests by then, and its link opens only the day
        if (row.detail.change !== "cancelled" && !involved.has(row.eventId)) return gone
        const { title, day } = eventNotice(actorName, row.detail, zone)
        const event = row.detail.change === "cancelled" ? "" : `&event=${row.eventId}`
        return { ...base, via: row.detail.via ?? null, title, snippet: null, href: `/calendar?date=${day}${event}` }
      }

      if (kind === "ai_pending") {
        const card = cards.get(row.groupKey?.slice(aiPendingKey("").length) ?? "")
        const agent = card?.tokenName ?? "Your agent"
        return {
          ...base,
          title: titleOf(kind, actorName, agent, row.changeCount),
          snippet: card ? pendingSnippet(card.items) : null,
          href: AI_PENDING_HREF,
        }
      }

      if (row.messageId) {
        const message = messageById.get(row.messageId)
        const ref = message ? chatIdFor(message, userId) : null
        const chat = ref ? await chatOf(ref) : null
        if (!message || !ref || !chat) return gone
        const where = chat.name ? `in ${chat.name}` : "in a direct message"
        return {
          ...base,
          title: titleOf(kind, actorName, where, row.changeCount),
          snippet: messagePreview(message.kind, message.content, names),
          href: `/messages?${ref.kind}=${ref.id}&message=${message.id}`,
        }
      }

      if (row.taskId) {
        const task = taskById.get(row.taskId)
        if (!task || !taskAccessLevel(task, userId, organizationId, viewer.isOrgAdmin)) return gone
        const comment = row.commentId ? commentById.get(row.commentId) : undefined
        if (row.commentId && !comment) return gone
        const label = taskLabel(task)
        return {
          ...base,
          title: titleOf(kind, actorName, kind === "mentioned" ? `on ${label}` : label, row.changeCount),
          snippet: comment ? messagePreview("text", comment.content, names) : label === task.title ? null : task.title,
          href: task.project ? `/project/${task.project.slug}?task=${task.id}` : `/?task=${task.id}`,
        }
      }

      if (row.fileId) {
        const { file, level } = await reachableLevel(row.fileId, viewer)
        if (!file || !level) return gone
        // A comment, or a mention in one, says nothing to a user who can no longer see comments
        const aboutComments = kind === "doc_comment" || !!row.groupKey?.startsWith(DOC_COMMENT_KEY)
        if (aboutComments && !canSeeComments(level)) return gone
        return {
          ...base,
          title: titleOf(kind, actorName, kind === "mentioned" ? `in ${file.fileName}` : file.fileName, row.changeCount),
          snippet: null,
          href: `/${file.docType}/${file.id}`,
        }
      }

      if (row.projectId) {
        const project = projectById.get(row.projectId)
        if (!project || (project.members.length === 0 && !viewer.isOrgAdmin)) return gone
        return { ...base, title: titleOf(kind, actorName, project.name, row.changeCount), snippet: null, href: `/project/${project.slug}` }
      }

      return gone
    }),
  )
}

/** The events behind these rows that the viewer still organises or is a guest of */
async function involvedEvents(viewer: Viewer, rows: Row[]): Promise<Set<string>> {
  const ids = unique(rows.map((row) => (row.kind === "event_changed" ? row.eventId : null)))
  if (ids.length === 0) return new Set()
  const [organised, invited] = await Promise.all([
    db
      .select({ id: calendarEvents.id })
      .from(calendarEvents)
      .where(
        and(
          inArray(calendarEvents.id, ids),
          eq(calendarEvents.organizationId, viewer.organizationId),
          eq(calendarEvents.createdBy, viewer.userId),
          liveEvent,
        ),
      ),
    db
      .select({ id: eventAttendees.eventId })
      .from(eventAttendees)
      .innerJoin(calendarEvents, eq(calendarEvents.id, eventAttendees.eventId))
      .where(
        and(
          inArray(eventAttendees.eventId, ids),
          eq(eventAttendees.userId, viewer.userId),
          eq(calendarEvents.organizationId, viewer.organizationId),
          liveEvent,
        ),
      ),
  ])
  return new Set([...organised, ...invited].map((row) => row.id))
}

export async function prefsOf(organizationId: string, userIds: string[]): Promise<Map<string, Prefs>> {
  if (userIds.length === 0) return new Map()
  const rows = await db
    .select({ userId: notificationPrefs.userId, prefs: notificationPrefs.prefs })
    .from(notificationPrefs)
    .where(and(eq(notificationPrefs.organizationId, organizationId), inArray(notificationPrefs.userId, userIds)))
  return new Map(rows.map((row) => [row.userId, row.prefs]))
}

export async function getPrefs(userId: string, organizationId: string): Promise<Record<Kind, KindPref>> {
  return resolvePrefs((await prefsOf(organizationId, [userId])).get(userId) ?? {})
}

const SUMMARY_PLACES = 500

type UnreadPlace = { id: string; taskId: string | null; chat: { kind: "dm" | "group"; id: string } | null }

/** What a client needs at start: the unread count, where the newest unread ones point, and whether mentions pop up */
export async function notificationSummary(userId: string, organizationId: string) {
  const [unread, rows, prefs] = await Promise.all([
    unreadCount(userId, organizationId),
    db
      .select({ id: notifications.id, taskId: notifications.taskId, chatKind: notifications.chatKind, chatId: notifications.chatId })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.organizationId, organizationId),
          isNull(notifications.readAt),
          or(isNotNull(notifications.taskId), isNotNull(notifications.chatId)),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(SUMMARY_PLACES),
    getPrefs(userId, organizationId),
  ])
  const places: UnreadPlace[] = rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    chat: row.chatKind && row.chatId ? { kind: row.chatKind as "dm" | "group", id: row.chatId } : null,
  }))
  return { unread, mentionDesktop: prefs.mentioned.desktop, places }
}
