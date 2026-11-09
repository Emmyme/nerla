import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm"
import {
  db,
  fileLinks,
  groupChatMembers,
  groupChatReads,
  groupChats,
  meetingParticipants,
  messages,
  organizationMembers,
  projects,
  users,
  type Executor,
  type Tx,
} from "../db"
import { CALL_GRACE_MS, nextAdmin, serverInstant, type ChatRef } from "../utils/chatAccess"
import { presenceName } from "../utils/presence"
import { liveProject } from "../utils/trash"
import { linkAttachments } from "./files"
import { liveRoomNames } from "./liveRooms"
import { membersOf } from "./tenancy"
import { sendToUser } from "./websocket"

/** Tells the users their chat lists changed, so they load them again */
export function chatsChanged(organizationId: string, userIds: string[]): void {
  for (const userId of new Set(userIds)) sendToUser(organizationId, userId, { type: "chats-changed" })
}

const HISTORY_PAGE = 50
const PINS_LIMIT = 100

/** Both users still belong to the workspace, so a removed member's open socket cannot keep acting */
export async function dmAllowed(organizationId: string, userId: string, partnerId: string): Promise<boolean> {
  return (await membersOf(organizationId, [userId, partnerId])).size === new Set([userId, partnerId]).size
}

/** Members who still belong to the group's organization */
export async function groupMemberIds(groupChatId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: groupChatMembers.userId })
    .from(groupChatMembers)
    .innerJoin(groupChats, eq(groupChats.id, groupChatMembers.groupChatId))
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.userId, groupChatMembers.userId), eq(organizationMembers.organizationId, groupChats.organizationId)),
    )
    .where(eq(groupChatMembers.groupChatId, groupChatId))
  return [...new Set(rows.map((row) => row.userId))]
}

type GroupAccess = {
  role: string
  chat: { id: string; name: string; organizationId: string; createdBy: string; projectId: string | null }
}

/** The user's membership of a group in the caller's workspace, only while they still belong to it */
export async function groupAccess(organizationId: string, userId: string, groupChatId: string): Promise<GroupAccess | null> {
  const [row] = await db
    .select({
      role: groupChatMembers.role,
      id: groupChats.id,
      name: groupChats.name,
      organizationId: groupChats.organizationId,
      createdBy: groupChats.createdBy,
      projectId: groupChats.projectId,
    })
    .from(groupChatMembers)
    .innerJoin(groupChats, eq(groupChats.id, groupChatMembers.groupChatId))
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, groupChats.organizationId)),
    )
    .leftJoin(projects, eq(projects.id, groupChats.projectId))
    .where(
      and(
        eq(groupChatMembers.groupChatId, groupChatId),
        eq(groupChatMembers.userId, userId),
        eq(groupChats.organizationId, organizationId),
        or(isNull(groupChats.projectId), liveProject),
      ),
    )
    .limit(1)
  if (!row) return null
  const { role, ...chat } = row
  return { role, chat }
}

/** Whether the user is in a project chat whose project is in Trash, which reads as not found like the project */
export async function inTrashedProjectChat(organizationId: string, userId: string, groupChatId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: groupChats.id })
    .from(groupChatMembers)
    .innerJoin(groupChats, eq(groupChats.id, groupChatMembers.groupChatId))
    .innerJoin(projects, and(eq(projects.id, groupChats.projectId), eq(projects.organizationId, organizationId)))
    .where(
      and(
        eq(groupChatMembers.groupChatId, groupChatId),
        eq(groupChatMembers.userId, userId),
        eq(groupChats.organizationId, organizationId),
        isNotNull(projects.deletedAt),
      ),
    )
    .limit(1)
  return !!row
}

/** The chat a user may act in, or null when they do not belong to it */
export async function chatRef(organizationId: string, userId: string, kind: "dm" | "group", id: string): Promise<ChatRef | null> {
  if (kind === "dm") return (await dmAllowed(organizationId, userId, id)) ? { kind: "dm", a: userId, b: id } : null
  if (!(await groupAccess(organizationId, userId, id))) return null
  return { kind: "group", id, memberIds: await groupMemberIds(id) }
}

/** The chat of a message, when the user may still act in it */
export async function chatForMessage(
  organizationId: string,
  userId: string,
  message: { senderId: string; recipientId: string | null; threadType: string | null; threadId: string | null },
): Promise<ChatRef | null> {
  if (message.threadType === "group" && message.threadId) return chatRef(organizationId, userId, "group", message.threadId)
  if (message.threadType || !message.recipientId) return null
  const other = message.senderId === userId ? message.recipientId : message.recipientId === userId ? message.senderId : null
  return other ? chatRef(organizationId, userId, "dm", other) : null
}

/** The messages of one chat in the workspace, seen from `userId` */
export function chatMessages(organizationId: string, userId: string, kind: "dm" | "group", id: string): SQL {
  const inOrg = eq(messages.organizationId, organizationId)
  if (kind === "group") return and(eq(messages.threadType, "group"), eq(messages.threadId, id), inOrg)!
  return and(
    isNull(messages.threadType),
    inOrg,
    or(and(eq(messages.senderId, userId), eq(messages.recipientId, id)), and(eq(messages.senderId, id), eq(messages.recipientId, userId))),
  )!
}

export async function displayName(userId: string): Promise<string> {
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { firstName: true, lastName: true },
  })
  return presenceName(row?.firstName ?? null, row?.lastName ?? null)
}

/** Every new message carries its workspace */
type NewMessage = typeof messages.$inferInsert & { organizationId: string }

/**
 * Saves a message once per client id. A retry within 10 minutes after a lost reply gets the message it already
 * made. The lock makes two sends with one client id take turns, so the second one finds the first.
 */
export async function insertMessageOnce(chat: SQL, values: NewMessage): Promise<{ id: string; created: boolean }> {
  const { senderId, clientId } = values
  if (!clientId) {
    const [row] = await db.insert(messages).values(values).returning({ id: messages.id })
    return { id: row.id, created: true }
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`message:${senderId}:${clientId}`}, 0))`)
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          chat,
          eq(messages.senderId, senderId),
          eq(messages.clientId, clientId),
          sql`${messages.createdAt} > (now() at time zone 'utc') - interval '10 minutes'`,
        ),
      )
      .limit(1)
    if (existing) return { id: existing.id, created: false }
    const [row] = await tx.insert(messages).values(values).returning({ id: messages.id })
    return { id: row.id, created: true }
  })
}

/** A reply may only quote a message of the same chat */
export async function replyInChat(where: SQL, replyToId: string | undefined): Promise<boolean> {
  if (!replyToId) return true
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(where, eq(messages.id, replyToId)))
    .limit(1)
  return !!row
}

/** Which calls can still be joined: inside their grace period, or with participants in the room, from one LiveKit lookup */
export async function liveCalls(calls: { roomName: string; createdAt: string }[]): Promise<Set<string>> {
  const now = Date.now()
  const live = new Set<string>()
  const check: string[] = []
  for (const call of calls) {
    const age = now - serverInstant(call.createdAt)
    if (age >= 0 && age < CALL_GRACE_MS) live.add(call.roomName)
    else check.push(call.roomName)
  }
  for (const name of await liveRoomNames(check)) live.add(name)
  return live
}

async function callLive(roomName: string, createdAt: string): Promise<boolean> {
  return (await liveCalls([{ roomName, createdAt }])).has(roomName)
}

async function latestCall(where: SQL): Promise<{ id: string; roomName: string; createdAt: string } | null> {
  const [row] = await db
    .select({ id: messages.id, meta: messages.meta, createdAt: messages.createdAt })
    .from(messages)
    .where(and(where, eq(messages.kind, "call")))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1)
  const roomName = row?.meta?.roomName
  return row && roomName ? { id: row.id, roomName, createdAt: row.createdAt } : null
}

/** The room of the chat's latest call while it is still live */
export async function liveCallRoom(where: SQL): Promise<string | null> {
  const call = await latestCall(where)
  return call && (await callLive(call.roomName, call.createdAt)) ? call.roomName : null
}

type ChatCallRoom = { groupChatId: string; organizationId: string; name: string }

const callRoomName = sql<string>`${messages.meta}->>'roomName'`

/** The group chat a call room was posted in */
export async function chatCallRoom(roomName: string): Promise<ChatCallRoom | null> {
  // tenancy: a room name is looked up across workspaces, and every caller compares the organizationId it returns
  const [row] = await db
    .select({ groupChatId: groupChats.id, organizationId: groupChats.organizationId, name: groupChats.name })
    .from(messages)
    .innerJoin(groupChats, eq(groupChats.id, messages.threadId))
    .where(and(eq(messages.kind, "call"), eq(messages.threadType, "group"), sql`${callRoomName} = ${roomName}`))
    .limit(1)
  return row ?? null
}

/**
 * A group chat's call room follows the group, not the rows seeded when the call started: a current member
 * in the group's organization, or a user a current member invited from inside the call.
 */
export async function chatCallAccess(
  userId: string,
  organizationId: string,
  call: ChatCallRoom,
  rows: { userId: string; invitedBy: string | null }[],
): Promise<boolean> {
  if (call.organizationId !== organizationId) return false
  const members = new Set(await groupMemberIds(call.groupChatId))
  if (members.has(userId)) return true
  const inviter = rows.find((row) => row.userId === userId)?.invitedBy
  return !!inviter && members.has(inviter)
}

/**
 * Deletes group chats with their messages and every participant row of their call rooms. Messages only
 * point at a chat through `thread_id`, so nothing cascades to them. Returns the users who were seated.
 */
export async function deleteGroupChats(chatIds: string[], tx: Tx): Promise<string[]> {
  if (chatIds.length === 0) return []
  const seated = await tx
    .select({ userId: groupChatMembers.userId })
    .from(groupChatMembers)
    .where(inArray(groupChatMembers.groupChatId, chatIds))
  const inChats = and(eq(messages.threadType, "group"), inArray(messages.threadId, chatIds))
  const rooms = tx
    .select({ room: callRoomName })
    .from(messages)
    .where(and(eq(messages.kind, "call"), inChats))
  await tx.delete(meetingParticipants).where(inArray(meetingParticipants.roomName, rooms))
  // Reactions and file links cascade from the messages, and the files stay with their owners
  await tx.delete(messages).where(inChats)
  await tx.delete(groupChats).where(inArray(groupChats.id, chatIds))
  return [...new Set(seated.map((m) => m.userId))]
}

/** Removes the users' participant rows for the call rooms of these group chats */
export async function dropCallAccess(userIds: string[], chatIds: string[], executor: Executor = db): Promise<void> {
  if (userIds.length === 0 || chatIds.length === 0) return
  const rooms = executor
    .select({ room: callRoomName })
    .from(messages)
    .where(and(eq(messages.kind, "call"), eq(messages.threadType, "group"), inArray(messages.threadId, chatIds)))
  await executor
    .delete(meetingParticipants)
    .where(and(inArray(meetingParticipants.userId, userIds), inArray(meetingParticipants.roomName, rooms)))
}

/** A group whose last admin left gets one: a project chat's project creator when they are in it, else its oldest member */
export async function keepAnAdmin(chatId: string, tx: Tx): Promise<void> {
  // trash: a project chat in Trash keeps an admin too, for when its project comes back
  const [chat] = await tx
    .select({ organizationId: groupChats.organizationId, createdBy: projects.createdBy })
    .from(groupChats)
    .leftJoin(projects, eq(projects.id, groupChats.projectId))
    .where(eq(groupChats.id, chatId))
  if (!chat) return
  // Only users still in the organization count, so a stale row never holds the place
  const remaining = await tx
    .select({ id: groupChatMembers.id, userId: groupChatMembers.userId, role: groupChatMembers.role })
    .from(groupChatMembers)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.userId, groupChatMembers.userId), eq(organizationMembers.organizationId, chat.organizationId)),
    )
    .where(eq(groupChatMembers.groupChatId, chatId))
    .orderBy(asc(groupChatMembers.joinedAt), asc(groupChatMembers.id))
  const pick = nextAdmin(remaining, chat.createdBy)
  if (pick) await tx.update(groupChatMembers).set({ role: "admin" }).where(eq(groupChatMembers.id, pick))
}

/** A user leaving an organization leaves its group chats and their call rooms, inside the caller's transaction */
export async function removeFromOrgChats(userId: string, organizationId: string, tx: Tx): Promise<void> {
  const chats = await tx.select({ id: groupChats.id }).from(groupChats).where(eq(groupChats.organizationId, organizationId))
  const chatIds = chats.map((chat) => chat.id)
  if (chatIds.length === 0) return
  await dropCallAccess([userId], chatIds, tx)
  const left = await tx
    .delete(groupChatMembers)
    .where(and(eq(groupChatMembers.userId, userId), inArray(groupChatMembers.groupChatId, chatIds)))
    .returning({ chatId: groupChatMembers.groupChatId })
  for (const chatId of [...new Set(left.map((row) => row.chatId))].sort()) await keepAnAdmin(chatId, tx)
}

export async function markGroupRead(groupChatId: string, userId: string): Promise<void> {
  const now = new Date().toISOString()
  // Covers every message already in the chat, even one stamped by a clock slightly ahead
  const point = sql`greatest(${now}::timestamp, coalesce((select max(${messages.createdAt}) from ${messages} where ${messages.threadType} = 'group' and ${messages.threadId} = ${groupChatId}), ${now}::timestamp))`
  const updated = await db
    .update(groupChatReads)
    .set({ lastReadAt: sql`greatest(${groupChatReads.lastReadAt}, ${point})` })
    .where(and(eq(groupChatReads.groupChatId, groupChatId), eq(groupChatReads.userId, userId)))
    .returning({ id: groupChatReads.id })
  if (updated.length === 0) {
    await db.insert(groupChatReads).values({ groupChatId, userId, lastReadAt: sql`${point}` })
  }
}

const MESSAGE_WITH = {
  // The same shape as LINKED_FILES in files.ts, spelled out because that module imports this one
  fileLinks: {
    with: { file: { with: { uploader: { columns: { removedAt: true } } } } },
    orderBy: [asc(fileLinks.createdAt), asc(fileLinks.id)] as SQL[],
  },
  reactions: {
    with: { user: { columns: { id: true, firstName: true, lastName: true } } },
  },
  sender: {
    columns: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true },
  },
  replyTo: {
    with: { sender: { columns: { id: true, firstName: true, lastName: true } } },
  },
} as const

function findMessages(where: SQL, options: { limit?: number; newestFirst?: boolean } = {}) {
  return db.query.messages.findMany({
    where,
    with: MESSAGE_WITH,
    orderBy: options.newestFirst ? [desc(messages.createdAt), desc(messages.id)] : [asc(messages.createdAt), asc(messages.id)],
    limit: options.limit,
  })
}

type MessageRow = Awaited<ReturnType<typeof findMessages>>[number]

export function messageDto(msg: MessageRow, live = false) {
  return {
    id: msg.id,
    sender_id: msg.senderId,
    recipient_id: msg.recipientId,
    thread_type: msg.threadType,
    thread_id: msg.threadId,
    kind: msg.kind,
    meta: msg.meta ?? null,
    live: msg.kind === "call" ? live : false,
    content: msg.content,
    is_read: msg.isRead,
    is_edited: msg.isEdited,
    edited_at: msg.editedAt,
    created_at: msg.createdAt,
    reply_to_id: msg.replyToId,
    is_pinned: msg.isPinned,
    pinned_at: msg.pinnedAt,
    done_via: msg.doneVia ?? null,
    reply_to: msg.replyTo
      ? {
          id: msg.replyTo.id,
          content: msg.replyTo.content,
          sender: msg.replyTo.sender
            ? {
                id: msg.replyTo.sender.id,
                first_name: msg.replyTo.sender.firstName,
                last_name: msg.replyTo.sender.lastName,
              }
            : null,
        }
      : null,
    sender: msg.sender
      ? {
          id: msg.sender.id,
          email: msg.sender.email,
          first_name: msg.sender.firstName,
          last_name: msg.sender.lastName,
          avatar_url: msg.sender.avatarUrl,
        }
      : null,
    attachments: linkAttachments(msg.fileLinks),
    reactions: msg.reactions.map((r) => ({
      id: r.id,
      emoji: r.emoji,
      user_id: r.userId,
      user: r.user ? { id: r.user.id, first_name: r.user.firstName, last_name: r.user.lastName } : null,
    })),
  }
}

export type MessageDto = ReturnType<typeof messageDto>

export async function loadMessageDto(id: string, live = false): Promise<MessageDto | null> {
  const [row] = await findMessages(eq(messages.id, id), { limit: 1 })
  return row ? messageDto(row, live) : null
}

type HistoryCursor = { before?: string; beforeId?: string; after?: string; afterId?: string }

/** Older than the cursor message, with the id breaking ties between equal timestamps */
function olderThan(cursor: HistoryCursor): SQL | undefined {
  if (!cursor.before) return undefined
  if (!cursor.beforeId) return lt(messages.createdAt, cursor.before)
  return or(lt(messages.createdAt, cursor.before), and(eq(messages.createdAt, cursor.before), lt(messages.id, cursor.beforeId)))
}

/** Newer than the cursor message, with the id breaking ties between equal timestamps */
function newerThan(at: string, id?: string): SQL {
  if (!id) return gt(messages.createdAt, at)
  return or(gt(messages.createdAt, at), and(eq(messages.createdAt, at), gt(messages.id, id)))!
}

async function withLive(where: SQL, rows: MessageRow[]): Promise<MessageDto[]> {
  const call = await latestCall(where)
  const live = call && rows.some((row) => row.id === call.id) ? await callLive(call.roomName, call.createdAt) : false
  return rows.map((row) => messageDto(row, row.id === call?.id && live))
}

/**
 * The newest messages before the cursor, or with `after` the oldest ones after it, oldest first either way.
 * Only the chat's latest call is checked for being live.
 */
export async function messagePage(where: SQL, cursor: HistoryCursor, limit = HISTORY_PAGE): Promise<MessageDto[]> {
  if (cursor.after) return withLive(where, await findMessages(and(where, newerThan(cursor.after, cursor.afterId))!, { limit }))
  const older = olderThan(cursor)
  const rows = await findMessages(older ? and(where, older)! : where, { limit, newestFirst: true })
  return withLive(where, rows.reverse())
}

/** A page with the message in the middle, oldest first, or null when the message is not in this chat */
export async function messageWindow(where: SQL, messageId: string, limit = HISTORY_PAGE): Promise<MessageDto[] | null> {
  // tenancy: `where` is one chat from chatMessages, which scopes it to the workspace
  const [target] = await db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(and(where, eq(messages.id, messageId)))
    .limit(1)
  if (!target) return null
  const newerCount = Math.floor(limit / 2)
  const atOrBefore = or(
    lt(messages.createdAt, target.createdAt),
    and(eq(messages.createdAt, target.createdAt), lte(messages.id, target.id)),
  )!
  const [older, newer] = await Promise.all([
    findMessages(and(where, atOrBefore)!, { limit: limit - newerCount, newestFirst: true }),
    findMessages(and(where, newerThan(target.createdAt, target.id))!, { limit: newerCount }),
  ])
  return withLive(where, [...older.reverse(), ...newer])
}

/** The chat's pinned messages, most recently pinned first. Calls are never pinned. */
export async function pinnedMessages(where: SQL): Promise<MessageDto[]> {
  const rows = await db.query.messages.findMany({
    where: and(where, eq(messages.isPinned, true), ne(messages.kind, "call")),
    with: MESSAGE_WITH,
    orderBy: [desc(messages.pinnedAt), desc(messages.id)],
    limit: PINS_LIMIT,
  })
  return rows.map((row) => messageDto(row))
}

type PinState = { id: string; is_pinned: boolean; pinned_at: string | null }

/** Pins or unpins, and says whether anything changed, so pinning twice keeps the first time */
export async function savePin(
  message: { id: string; isPinned: boolean; pinnedAt: string | null },
  pinned: boolean,
): Promise<PinState & { changed: boolean }> {
  if (message.isPinned === pinned) {
    return { id: message.id, is_pinned: message.isPinned, pinned_at: message.pinnedAt, changed: false }
  }
  const [row] = await db
    .update(messages)
    .set({ isPinned: pinned, pinnedAt: pinned ? new Date().toISOString() : null })
    .where(eq(messages.id, message.id))
    .returning({ isPinned: messages.isPinned, pinnedAt: messages.pinnedAt })
  return { id: message.id, is_pinned: row.isPinned, pinned_at: row.pinnedAt, changed: true }
}
