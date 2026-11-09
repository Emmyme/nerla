import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import {
  calendarEvents,
  db,
  docCommentHides,
  docComments,
  messages,
  notificationPrefs,
  notifications,
  projects,
  tasks,
  type Tx,
} from "../db"
import { canSeeComments } from "../utils/docAccess"
import { logger } from "../utils/logger"
import {
  aiPendingKey,
  changesIn,
  groupKey,
  recipientsFor,
  resolvePrefs,
  shouldGroup,
  type Candidate,
  type Kind,
  type KindPref,
  type NotificationEvent,
  type Prefs,
  type Recipient,
} from "../utils/notificationRules"
import { canAccessTask } from "../utils/taskAccess"
import { liveProject, liveTask } from "../utils/trash"
import { groupMemberIds } from "./chats"
import { findDoc, memberViewer, reachableLevel } from "./docs"
import { chatIdFor, prefsOf, resolveItems, unique, unreadCount } from "./notificationList"
import { membersOf } from "./tenancy"
import { sendToUser } from "./websocket"
import { errorText } from "../utils/errorText"

type Row = typeof notifications.$inferSelect

/** Where a notification points, as its recipient knows it */
type Refs = Pick<Row, "projectId" | "taskId" | "commentId" | "messageId" | "fileId" | "eventId" | "detail" | "chatKind" | "chatId">
const NO_REFS: Refs = {
  projectId: null,
  taskId: null,
  commentId: null,
  messageId: null,
  fileId: null,
  eventId: null,
  detail: null,
  chatKind: null,
  chatId: null,
}

type Source = { candidates: Omit<Candidate, "prefs">[]; refs: (userId: string) => Refs }

/** Merges the change into the stored prefs, one row per user and workspace, and tells the user's other sessions */
export async function savePrefs(userId: string, organizationId: string, change: Prefs): Promise<Record<Kind, KindPref>> {
  const prefs = await mergePrefs(userId, organizationId, change)
  try {
    push(organizationId, userId, "notification:prefs", { prefs })
  } catch (error) {
    logger.warn("Sending notification settings failed", { error: errorText(error) })
  }
  return prefs
}

async function mergePrefs(userId: string, organizationId: string, change: Prefs): Promise<Record<Kind, KindPref>> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`notification-prefs:${organizationId}:${userId}`}, 0))`)
    const [existing] = await tx
      .select({ id: notificationPrefs.id, prefs: notificationPrefs.prefs })
      .from(notificationPrefs)
      .where(and(eq(notificationPrefs.userId, userId), eq(notificationPrefs.organizationId, organizationId)))
      .limit(1)
    const merged: Prefs = { ...existing?.prefs }
    for (const [kind, pref] of Object.entries(change) as [Kind, Partial<KindPref>][]) merged[kind] = { ...merged[kind], ...pref }
    const now = new Date().toISOString()
    if (existing) {
      await tx
        .update(notificationPrefs)
        .set({ prefs: merged, updatedAt: now })
        .where(and(eq(notificationPrefs.id, existing.id), eq(notificationPrefs.organizationId, organizationId)))
    } else {
      await tx.insert(notificationPrefs).values({ organizationId, userId, prefs: merged, updatedAt: now })
    }
    return resolvePrefs(merged)
  })
}

/** Who might hear about the event, with how they relate to its place and whether they can see it */
async function sourceOf(organizationId: string, event: NotificationEvent): Promise<Source | null> {
  if (event.type === "ai_pending") {
    return {
      candidates: [{ userId: event.userId, isActor: false, relations: [], canSee: true, mentioned: false }],
      refs: () => NO_REFS,
    }
  }

  if (event.type === "event_changed") {
    // trash: a cancel is told about an event that is in Trash by then
    const [found] = await db
      .select({ id: calendarEvents.id, title: calendarEvents.title })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, event.eventId), eq(calendarEvents.organizationId, organizationId)))
    if (!found) return null
    const detail = { change: event.change, startsAt: event.startsAt, allDay: event.allDay, title: found.title, via: event.via ?? null }
    return {
      candidates: event.userIds.map((id) => ({
        userId: id,
        isActor: id === event.actorId,
        relations: [id === event.organiserId ? "organiser" : "guest"],
        canSee: true,
        mentioned: false,
      })),
      refs: () => ({ ...NO_REFS, eventId: found.id, detail }),
    }
  }

  if (event.type === "project_added") {
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, event.projectId), eq(projects.organizationId, organizationId), liveProject),
      columns: { id: true },
      with: { members: { columns: { userId: true } } },
    })
    if (!project) return null
    const members = new Set(project.members.map((m) => m.userId))
    return {
      candidates: event.userIds.map((id) => ({
        userId: id,
        isActor: id === event.actorId,
        relations: ["project_member"],
        canSee: members.has(id),
        mentioned: false,
      })),
      refs: () => ({ ...NO_REFS, projectId: project.id }),
    }
  }

  if (event.type === "message") {
    const message = await db.query.messages.findFirst({
      where: and(eq(messages.id, event.messageId), eq(messages.organizationId, organizationId)),
      columns: { id: true, senderId: true, recipientId: true, threadType: true, threadId: true },
    })
    if (!message) return null
    const chat = chatIdFor(message, message.senderId)
    const audience = !chat ? [] : chat.kind === "group" ? await groupMemberIds(chat.id) : [message.senderId, chat.id]
    const inChat = new Set(audience)
    return {
      candidates: event.mentions
        .filter((id) => inChat.has(id))
        .map((id) => ({ userId: id, isActor: id === event.actorId, relations: ["chat_member"], canSee: true, mentioned: true })),
      refs: (userId) => {
        const chat = chatIdFor(message, userId)
        return { ...NO_REFS, messageId: message.id, chatKind: chat?.kind ?? null, chatId: chat?.id ?? null }
      },
    }
  }

  if (event.type === "doc_shared" || event.type === "doc_comment" || event.type === "doc_mention") {
    return docSource(organizationId, event)
  }

  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, event.taskId), eq(tasks.organizationId, organizationId), liveTask),
    columns: { id: true, projectId: true, assignedTo: true, createdBy: true, organizationId: true, deletedAt: true },
    with: { project: { columns: { organizationId: true, deletedAt: true }, with: { members: { columns: { userId: true } } } } },
  })
  if (!task) return null
  const members = new Set(task.projectId ? (task.project?.members ?? []).map((m) => m.userId) : [])
  // Mentions in task comments reach members of the task's project, and nobody on a personal task
  const mentioned = new Set(event.type === "comment" ? event.mentions.filter((id) => members.has(id)) : [])
  const ids = unique([...members, task.assignedTo, task.createdBy, ...mentioned])
  return {
    candidates: ids.map((id) => ({
      userId: id,
      isActor: id === event.actorId,
      relations: [
        ...(task.assignedTo === id ? (["assignee"] as const) : []),
        ...(task.createdBy === id ? (["creator"] as const) : []),
        ...(members.has(id) ? (["project_member"] as const) : []),
      ],
      canSee: canAccessTask(task, id, organizationId),
      mentioned: mentioned.has(id),
    })),
    refs: () => ({ ...NO_REFS, taskId: task.id, commentId: event.type === "comment" ? event.commentId : null }),
  }
}

/**
 * Users granted a paper or board, mentioned in its text or a comment, or its owner and the others in a comment's
 * thread, who can reach it now, also through a call share it is shown in
 */
async function docSource(
  organizationId: string,
  event: Extract<NotificationEvent, { type: "doc_shared" | "doc_comment" | "doc_mention" }>,
): Promise<Source | null> {
  const file = await findDoc(event.fileId, organizationId)
  if (!file) return null
  const refs = () => ({ ...NO_REFS, fileId: event.fileId })
  if (event.type === "doc_mention") {
    // A user in the call a paper is shown in can open it through the share, as the text's mentions were recorded
    const candidates = await Promise.all(
      event.userIds.map(async (userId) => {
        const { level } = await reachableLevel(event.fileId, await memberViewer(userId, organizationId))
        return { userId, isActor: userId === event.actorId, relations: [], canSee: level !== null, mentioned: true }
      }),
    )
    return { candidates, refs }
  }
  const relations = new Map<string, Candidate["relations"]>()
  const add = (userId: string | null, relation: Candidate["relations"][number]) => {
    if (userId) relations.set(userId, [...(relations.get(userId) ?? []), relation])
  }
  const mentioned = new Set(event.type === "doc_comment" ? event.mentions : [])
  if (event.type === "doc_shared") {
    for (const userId of event.userIds) add(userId, "grantee")
  } else {
    const [comment] = await db
      .select({ id: docComments.id, parentId: docComments.parentId })
      .from(docComments)
      .where(and(eq(docComments.id, event.commentId), eq(docComments.fileId, event.fileId), eq(docComments.organizationId, organizationId)))
    if (!comment) return null
    for (const userId of mentioned) relations.set(userId, relations.get(userId) ?? [])
    if (!event.edited) {
      // A user who hid the thread hears nothing more of it, unless a reply mentions them
      const hiders = comment.parentId
        ? await db
            .select({ userId: docCommentHides.userId })
            .from(docCommentHides)
            .where(and(eq(docCommentHides.commentId, comment.parentId), eq(docCommentHides.organizationId, organizationId)))
        : []
      const hid = new Set(hiders.map((row) => row.userId))
      const involve = (userId: string | null, relation: "doc_owner" | "thread_member") => {
        if (userId && !hid.has(userId)) add(userId, relation)
      }
      involve(file.uploadedBy, "doc_owner")
      if (comment.parentId) {
        const thread = await db
          .select({ authorId: docComments.authorId })
          .from(docComments)
          .where(
            and(
              eq(docComments.organizationId, organizationId),
              eq(docComments.fileId, event.fileId),
              or(eq(docComments.id, comment.parentId), eq(docComments.parentId, comment.parentId)),
            ),
          )
        for (const userId of unique(thread.map((row) => row.authorId))) involve(userId, "thread_member")
      }
    }
  }
  const candidates = await Promise.all(
    [...relations].map(async ([userId, rels]) => {
      const { level } = await reachableLevel(event.fileId, await memberViewer(userId, organizationId))
      return {
        userId,
        isActor: userId === event.actorId,
        relations: rels,
        canSee: event.type === "doc_shared" ? level !== null : canSeeComments(level),
        mentioned: mentioned.has(userId),
      }
    }),
  )
  return { candidates, refs }
}

function push(organizationId: string, userId: string, type: string, payload: Record<string, unknown>) {
  sendToUser(organizationId, userId, { type, ...payload })
}

async function deliver(organizationId: string, event: NotificationEvent, recipient: Recipient, refs: Refs, now: Date) {
  const viewer = { userId: recipient.userId, organizationId, isOrgAdmin: false }
  const at = now.toISOString()
  const key = groupKey(event, recipient.kind)
  const fresh = { organizationId, userId: recipient.userId, kind: recipient.kind, actorId: event.actorId, ...refs, groupKey: key }

  // A pop-up without a bell entry keeps nothing
  if (!recipient.bell) {
    const row: Row = { id: randomUUID(), ...fresh, changeCount: changesIn(event), readAt: at, createdAt: at, updatedAt: at }
    const [item] = await resolveItems(viewer, [row])
    push(organizationId, recipient.userId, "notification:new", {
      item,
      unread: await unreadCount(recipient.userId, organizationId),
      bell: false,
      desktop: true,
    })
    return
  }

  const outcome = await db.transaction(async (tx) => {
    // A paper's text mentions a user once, which its own record keeps, so only comments and messages need this
    const mentionRef = recipient.kind === "mentioned" ? (refs.commentId ?? refs.messageId) : null
    const lockKey = key ?? (mentionRef ? `mention:${mentionRef}` : null)
    if (lockKey) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`notify:${recipient.userId}:${lockKey}`}, 0))`)
    }
    if (mentionRef) {
      // An edit that mentions a user again never adds a second entry for the same comment or message
      const [already] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, recipient.userId),
            eq(notifications.organizationId, organizationId),
            eq(notifications.kind, "mentioned"),
            refs.commentId ? eq(notifications.commentId, refs.commentId) : eq(notifications.messageId, mentionRef),
          ),
        )
        .limit(1)
      if (already) return null
    }
    if (key) {
      const [existing] = await tx
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, recipient.userId),
            eq(notifications.organizationId, organizationId),
            eq(notifications.groupKey, key),
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(1)
      if (existing && shouldGroup(existing, { groupKey: key }, now)) {
        const [row] = await tx
          .update(notifications)
          .set({
            changeCount: sql`${notifications.changeCount} + ${changesIn(event)}`,
            // A later change to the same event says where it is now
            ...(refs.detail ? { detail: refs.detail } : {}),
            readAt: null,
            createdAt: at,
            updatedAt: at,
          })
          .where(and(eq(notifications.id, existing.id), eq(notifications.organizationId, organizationId)))
          .returning()
        // A purge meanwhile took the entry, and nothing is left to show
        return row ? { row, merged: true } : null
      }
    }
    const [row] = await tx
      .insert(notifications)
      .values({ ...fresh, organizationId, changeCount: changesIn(event), createdAt: at, updatedAt: at })
      .returning()
    return { row, merged: false }
  })
  if (!outcome) return

  const [item] = await resolveItems(viewer, [outcome.row])
  const unread = await unreadCount(recipient.userId, organizationId)
  // A merged change moves the entry up without popping up again
  if (outcome.merged) push(organizationId, recipient.userId, "notification:updated", { item, unread })
  else push(organizationId, recipient.userId, "notification:new", { item, unread, bell: true, desktop: recipient.desktop })
}

async function notifyNow(organizationId: string, event: NotificationEvent): Promise<void> {
  const source = await sourceOf(organizationId, event)
  if (!source || source.candidates.length === 0) return
  const inWorkspace = await membersOf(
    organizationId,
    source.candidates.map((c) => c.userId),
  )
  const prefs = await prefsOf(organizationId, [...inWorkspace])
  const candidates = source.candidates.filter((c) => inWorkspace.has(c.userId)).map((c) => ({ ...c, prefs: prefs.get(c.userId) ?? {} }))
  const now = new Date()
  for (const recipient of recipientsFor(event, candidates)) {
    try {
      await deliver(organizationId, event, recipient, source.refs(recipient.userId), now)
    } catch (error) {
      logger.warn("Delivering a notification failed", {
        type: event.type,
        kind: recipient.kind,
        error: errorText(error),
      })
    }
  }
}

/** Runs after the change it is about has committed. A failure here never fails the change */
export async function notify(organizationId: string, event: NotificationEvent): Promise<void> {
  try {
    await notifyNow(organizationId, event)
  } catch (error) {
    logger.warn("Notifying failed", { type: event.type, error: errorText(error) })
  }
}

type ReadTarget = { ids?: string[]; taskId?: string; chat?: { kind: "dm" | "group"; id: string } }

/** Marks the viewer's unread notifications for these places read, and tells their other sessions */
export async function markRead(userId: string, organizationId: string, target: ReadTarget | "all"): Promise<number> {
  const which =
    target === "all"
      ? undefined
      : or(
          target.ids?.length ? inArray(notifications.id, target.ids) : undefined,
          target.taskId ? eq(notifications.taskId, target.taskId) : undefined,
          target.chat ? and(eq(notifications.chatKind, target.chat.kind), eq(notifications.chatId, target.chat.id)) : undefined,
        )
  if (target !== "all" && !which) return unreadCount(userId, organizationId)
  const marked = await db
    .update(notifications)
    .set({ readAt: new Date().toISOString() })
    .where(and(eq(notifications.userId, userId), eq(notifications.organizationId, organizationId), isNull(notifications.readAt), which))
    .returning({ id: notifications.id })
  const unread = await unreadCount(userId, organizationId)
  if (marked.length > 0) push(organizationId, userId, "notification:read", { unread, ids: marked.map((row) => row.id) })
  return unread
}

/** Reading a chat reads its mentions. A failure leaves them unread and never fails the read */
export async function markChatRead(userId: string, organizationId: string, chat: { kind: "dm" | "group"; id: string }): Promise<void> {
  try {
    await markRead(userId, organizationId, { chat })
  } catch (error) {
    logger.warn("Marking chat mentions read failed", { error: errorText(error) })
  }
}

type SourceRef = { taskId: string } | { commentId: string } | { messageId: string }

/** Deletes a source's notifications inside the caller's transaction and returns them by owner, to announce after the commit */
export async function dropNotifications(tx: Tx, organizationId: string, source: SourceRef): Promise<Map<string, string[]>> {
  const match =
    "taskId" in source
      ? eq(notifications.taskId, source.taskId)
      : "commentId" in source
        ? eq(notifications.commentId, source.commentId)
        : eq(notifications.messageId, source.messageId)
  const gone = await tx
    .delete(notifications)
    .where(and(match, eq(notifications.organizationId, organizationId)))
    .returning({ id: notifications.id, userId: notifications.userId })
  return removedByUser(gone)
}

/** Removed notification ids grouped by the user they belonged to, as `announceRemoved` takes them */
export function removedByUser(rows: { id: string; userId: string }[]): Map<string, string[]> {
  const byUser = new Map<string, string[]>()
  for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.id])
  return byUser
}

/** Tells users their notifications went with their source, with their new unread count */
export async function announceRemoved(organizationId: string, removed: Map<string, string[]>): Promise<void> {
  for (const [userId, ids] of removed) {
    try {
      push(organizationId, userId, "notification:read", { unread: await unreadCount(userId, organizationId), ids: [], removed: ids })
    } catch (error) {
      logger.warn("Sending an unread count failed", { error: errorText(error) })
    }
  }
}

/** A closed card's notice goes with it */
export async function dropAiPending(organizationId: string, userId: string, heldId: string): Promise<void> {
  const gone = await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.organizationId, organizationId),
        eq(notifications.userId, userId),
        eq(notifications.groupKey, aiPendingKey(heldId)),
      ),
    )
    .returning({ id: notifications.id })
  if (gone.length > 0) await announceRemoved(organizationId, new Map([[userId, gone.map((row) => row.id)]]))
}

/** A user leaving a workspace leaves their notifications and prefs there behind */
export async function dropMemberNotifications(tx: Tx, userId: string, organizationId: string): Promise<void> {
  await tx.delete(notifications).where(and(eq(notifications.userId, userId), eq(notifications.organizationId, organizationId)))
  await tx.delete(notificationPrefs).where(and(eq(notificationPrefs.userId, userId), eq(notificationPrefs.organizationId, organizationId)))
}
