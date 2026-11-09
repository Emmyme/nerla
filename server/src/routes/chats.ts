import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { authMiddleware } from "../middleware/auth"
import { db, groupChats, messages, organizationMembers, users } from "../db"
import { emitToChat, sendToUser } from "../services/websocket"
import { roomChangedLater } from "../services/presence"
import { seedParticipants } from "../services/liveRooms"
import { chatMessages, chatRef, liveCallRoom, liveCalls, loadMessageDto, pinnedMessages } from "../services/chats"
import { mentionNames } from "../services/mentions"
import { orgMiddleware, orgOf } from "../services/tenancy"
import { LIVE_PROJECT_SQL } from "../utils/trash"
import { saidByAi, type Via } from "../utils/aiTypes"
import { chatAudience, chatCallPlan, isUnread, messagePreview, serverInstant, threadOf, CALL_GRACE_MS } from "../utils/chatAccess"
import { parseParams } from "../validation/helpers"
import { chatParamsSchema } from "../validation/schemas"

const MEMBER_PREVIEW = 4

const callRateLimit = { max: 20, timeWindow: "1 minute" as const }
const pinsRateLimit = { max: 60, timeWindow: "1 minute" as const }

type Person = { id: string; first_name: string | null; last_name: string | null; avatar_url: string | null }

type LastRow = {
  id: string
  sender_id: string
  content: string
  kind: string
  room: string | null
  created_at: string
  done_via: Via | null
}

type ChatSummary = {
  kind: "dm" | "group"
  id: string
  title: string
  project_id: string | null
  /** A group's symbol and colour key, or a project chat's symbol and hex colour. A DM has neither */
  icon: string | null
  color: string | null
  /** A group's own picture, which it shows in place of a symbol */
  avatar_url?: string | null
  members: Person[]
  member_count: number
  /** `done_via` says the AI said it, or that an agent or the AI posted it for the sender */
  last_message: {
    id: string
    sender_id: string
    preview: string
    kind: string
    created_at: string
    live: boolean
    done_via: Via | null
  } | null
  last_activity_at: string
  unread: boolean
  /** Both users in a DM, a group's admins and creator */
  can_pin: boolean
  pin_count: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw SQL rows carry no column types
type SqlRow = Record<string, any>

function rows<T>(result: unknown): T[] {
  return Array.from(result as Iterable<T>)
}

function lastMessage(row: LastRow | null): ChatSummary["last_message"] {
  if (!row) return null
  return {
    id: row.id,
    sender_id: row.sender_id,
    preview: messagePreview(row.kind, row.content, undefined, saidByAi(row.done_via)),
    kind: row.kind,
    created_at: row.created_at,
    live: false,
    done_via: row.done_via ?? null,
  }
}

function later(a: string, b: string | null): string {
  if (!b) return a
  return serverInstant(b) > serverInstant(a) ? b : a
}

function fullName(user: { firstName: string | null; lastName: string | null; email: string }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email
}

/**
 * A summary with the room of its last message when that is a call, so one LiveKit lookup covers the list,
 * and its text, so one lookup names everyone the previews mention
 */
type Pending = { summary: ChatSummary; room: string | null; content: string | null }

async function groupSummaries(userId: string, organizationId: string): Promise<Pending[]> {
  // Groups of the user's own organization only, so a membership kept from another one never shows
  const mine = sql`(select gcm.group_chat_id from group_chat_members gcm
    join group_chats g on g.id = gcm.group_chat_id
    where gcm.user_id = ${userId} and g.organization_id = ${organizationId})`
  const [chats, previews] = await Promise.all([
    db.execute(sql`
      select gc.id, gc.name, gc.project_id, gc.updated_at, gc.created_by,
        case when pr.id is null then gc.icon else pr.icon end as icon,
        case when pr.id is null then gc.color else pr.color end as color,
        case when pr.id is null and gc.avatar_file_id is not null
          then '/group-chats/' || gc.id || '/avatar/' || gc.avatar_file_id end as avatar_url,
        (select bool_or(p.role = 'admin') from group_chat_members p
          where p.group_chat_id = gc.id and p.user_id = ${userId}) as is_admin,
        lm.id as lm_id, lm.sender_id as lm_sender, lm.content as lm_content, lm.kind as lm_kind,
        lm.meta->>'roomName' as lm_room, lm.created_at as lm_at, lm.done_via as lm_via,
        (select max(o.created_at) from messages o
          where o.thread_type = 'group' and o.thread_id = gc.id and o.sender_id <> ${userId}) as others_at,
        (select max(r.last_read_at) from group_chat_reads r
          where r.group_chat_id = gc.id and r.user_id = ${userId}) as read_at,
        (select count(*) from messages pm
          where pm.thread_type = 'group' and pm.thread_id = gc.id and pm.is_pinned and pm.kind <> 'call') as pin_count
      from group_chats gc
      left join projects pr on pr.id = gc.project_id
      left join lateral (
        select m.id, m.sender_id, m.content, m.kind, m.meta, m.created_at, m.done_via from messages m
        where m.thread_type = 'group' and m.thread_id = gc.id
        order by m.created_at desc, m.id desc limit 1
      ) lm on true
      where gc.id in ${mine} and (gc.project_id is null or ${LIVE_PROJECT_SQL("pr")})
    `),
    db.execute(sql`
      select group_chat_id, user_id, first_name, last_name, avatar_url, others from (
        select gcm.group_chat_id, u.id as user_id, u.first_name, u.last_name, u.avatar_url,
          row_number() over (partition by gcm.group_chat_id order by gcm.joined_at, u.id) as rn,
          count(*) over (partition by gcm.group_chat_id) as others
        from group_chat_members gcm join users u on u.id = gcm.user_id
        join organization_members om on om.user_id = gcm.user_id and om.organization_id = ${organizationId}
        where gcm.group_chat_id in ${mine} and gcm.user_id <> ${userId}
      ) t where rn <= ${MEMBER_PREVIEW}
    `),
  ])

  const members = new Map<string, { people: Person[]; others: number }>()
  for (const row of rows<SqlRow>(previews)) {
    const entry = members.get(row.group_chat_id) ?? { people: [], others: Number(row.others) }
    entry.people.push({ id: row.user_id, first_name: row.first_name, last_name: row.last_name, avatar_url: row.avatar_url })
    members.set(row.group_chat_id, entry)
  }

  return rows<SqlRow>(chats).map((row) => {
    const last = lastMessage(
      row.lm_id
        ? {
            id: row.lm_id,
            sender_id: row.lm_sender,
            content: row.lm_content,
            kind: row.lm_kind,
            room: row.lm_room,
            created_at: row.lm_at,
            done_via: row.lm_via ?? null,
          }
        : null,
    )
    const people = members.get(row.id)
    const summary: ChatSummary = {
      kind: "group",
      id: row.id,
      title: row.name,
      project_id: row.project_id ?? null,
      icon: row.icon ?? null,
      color: row.color ?? null,
      avatar_url: row.avatar_url ?? null,
      members: people?.people ?? [],
      member_count: (people?.others ?? 0) + 1,
      last_message: last,
      last_activity_at: later(row.updated_at, row.lm_at ?? null),
      unread: isUnread(row.others_at ?? null, row.read_at ?? null),
      can_pin: row.is_admin === true || row.created_by === userId,
      pin_count: Number(row.pin_count ?? 0),
    }
    return { summary, room: last?.kind === "call" ? (row.lm_room ?? null) : null, content: row.lm_content ?? null }
  })
}

async function dmSummaries(userId: string, organizationId: string): Promise<Pending[]> {
  const inOrg = sql`organization_id = ${organizationId}`
  const [latest, unread, pins] = await Promise.all([
    db.execute(sql`
      select distinct on (partner) partner, id, sender_id, content, kind, room, created_at, done_via from (
        select case when sender_id = ${userId} then recipient_id else sender_id end as partner,
          id, sender_id, content, kind, meta->>'roomName' as room, created_at, done_via
        from messages
        where thread_type is null and recipient_id is not null and ${inOrg}
          and (sender_id = ${userId} or recipient_id = ${userId})
      ) t
      order by partner, created_at desc, id desc
    `),
    db
      .selectDistinct({ partner: messages.senderId })
      .from(messages)
      .where(
        and(
          eq(messages.recipientId, userId),
          eq(messages.isRead, false),
          isNull(messages.threadType),
          eq(messages.organizationId, organizationId),
        ),
      ),
    db.execute(sql`
      select case when sender_id = ${userId} then recipient_id else sender_id end as partner, count(*) as pins
      from messages
      where thread_type is null and recipient_id is not null and is_pinned and kind <> 'call' and ${inOrg}
        and (sender_id = ${userId} or recipient_id = ${userId})
      group by partner
    `),
  ])

  const last = rows<LastRow & { partner: string }>(latest)
  const partnerIds = last.map((row) => row.partner)
  if (partnerIds.length === 0) return []

  // Only partners still in the workspace, since chats stay inside one organization
  const people = await db
    .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName, avatarUrl: users.avatarUrl })
    .from(users)
    .innerJoin(organizationMembers, and(eq(organizationMembers.userId, users.id), eq(organizationMembers.organizationId, organizationId)))
    .where(inArray(users.id, partnerIds))
  const byId = new Map(people.map((person) => [person.id, person]))
  const unreadFrom = new Set(unread.map((row) => row.partner))
  const pinsWith = new Map(rows<{ partner: string; pins: string }>(pins).map((row) => [row.partner, Number(row.pins)]))

  const summaries = last.map((row): Pending | null => {
    const person = byId.get(row.partner)
    if (!person) return null
    const message = lastMessage(row)
    const summary: ChatSummary = {
      kind: "dm",
      id: person.id,
      title: fullName(person),
      project_id: null,
      icon: null,
      color: null,
      members: [{ id: person.id, first_name: person.firstName, last_name: person.lastName, avatar_url: person.avatarUrl }],
      member_count: person.id === userId ? 1 : 2,
      last_message: message,
      last_activity_at: row.created_at,
      unread: unreadFrom.has(person.id),
      can_pin: true,
      pin_count: pinsWith.get(person.id) ?? 0,
    }
    return { summary, room: message?.kind === "call" ? row.room : null, content: row.content }
  })
  return summaries.filter((pending): pending is Pending => pending !== null)
}

async function chatRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  /** DMs and groups in one list, most recent activity first */
  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { user } = request
    try {
      const { organizationId } = orgOf(request)
      const [groups, dms] = await Promise.all([groupSummaries(user.id, organizationId), dmSummaries(user.id, organizationId)])
      const pending = [...groups, ...dms]
      const [live, names] = await Promise.all([
        liveCalls(
          pending.flatMap(({ summary, room }) =>
            room && summary.last_message ? [{ roomName: room, createdAt: summary.last_message.created_at }] : [],
          ),
        ),
        mentionNames(
          organizationId,
          pending.map(({ content }) => content),
        ),
      ])
      for (const { summary, room, content } of pending) {
        const last = summary.last_message
        if (!last) continue
        if (room) last.live = live.has(room)
        if (content) last.preview = messagePreview(last.kind, content, names, saidByAi(last.done_via))
      }
      const list = pending
        .map(({ summary }) => summary)
        .sort((a, b) => serverInstant(b.last_activity_at) - serverInstant(a.last_activity_at))
      return reply.send(list)
    } catch (error) {
      fastify.log.error(error, "Error fetching chats")
      return reply.code(500).send({ error: "Failed to fetch chats" })
    }
  })

  /** The chat's pinned messages, most recently pinned first, in the shape history uses */
  fastify.get("/:kind/:id/pins", { config: { rateLimit: pinsRateLimit } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { user } = request
    const params = parseParams(chatParamsSchema, request.params, reply)
    if (!params) return

    try {
      const { organizationId } = orgOf(request)
      const chat = await chatRef(organizationId, user.id, params.kind, params.id)
      if (!chat) return reply.code(403).send({ error: "Not a member of this chat" })
      return reply.send(await pinnedMessages(chatMessages(organizationId, user.id, params.kind, params.id)))
    } catch (error) {
      fastify.log.error(error, "Error fetching pinned messages")
      return reply.code(500).send({ error: "Failed to load pinned messages" })
    }
  })

  /** Starts a call with everyone in the chat, or joins the one still running, and posts it in the chat */
  fastify.post("/:kind/:id/call", { config: { rateLimit: callRateLimit } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { user } = request
    const params = parseParams(chatParamsSchema, request.params, reply)
    if (!params) return

    try {
      const { organizationId } = orgOf(request)
      const chat = await chatRef(organizationId, user.id, params.kind, params.id)
      if (!chat) return reply.code(403).send({ error: "Not a member of this chat" })

      const where = chatMessages(organizationId, user.id, params.kind, params.id)
      const plan = chatCallPlan(organizationId, threadOf(chat), await liveCallRoom(where))
      const audience = chatAudience(threadOf(chat))

      await seedParticipants(organizationId, plan.roomName, audience)

      if (plan.post) {
        const now = new Date().toISOString()
        const [message] = await db
          .insert(messages)
          .values({
            senderId: user.id,
            recipientId: chat.kind === "dm" ? chat.b : null,
            threadType: chat.kind === "group" ? "group" : null,
            threadId: chat.kind === "group" ? chat.id : null,
            organizationId,
            kind: "call",
            meta: { roomName: plan.roomName },
            content: "",
            createdAt: now,
          })
          .returning({ id: messages.id })
        if (chat.kind === "group") {
          await db.update(groupChats).set({ updatedAt: now }).where(eq(groupChats.id, chat.id))
        }

        // The grace ends without any count changing, so rows of a call nobody joined need a push then
        roomChangedLater(plan.roomName, CALL_GRACE_MS + 1000)

        const dto = await loadMessageDto(message.id, true)
        emitToChat(organizationId, chat, chat.kind === "dm" ? "new-message" : "new-group-message", {
          message: { ...dto!, client_id: null },
        })

        const caller = await db.query.users.findFirst({
          where: eq(users.id, user.id),
          columns: { firstName: true, lastName: true, email: true },
        })
        const callerName = caller ? fullName(caller) : user.email
        const group =
          chat.kind === "group" ? await db.query.groupChats.findFirst({ where: eq(groupChats.id, chat.id), columns: { name: true } }) : null
        for (const memberId of audience) {
          if (memberId === user.id) continue
          sendToUser(organizationId, memberId, {
            type: "meeting-invite",
            roomName: plan.roomName,
            title: group?.name ?? callerName,
            callerName,
            callerEmail: user.email,
            callerId: user.id,
            // The chat as the called user knows it, so the call can lead back to it
            chat: chat.kind === "group" ? { kind: "group", id: chat.id } : { kind: "dm", id: user.id },
          })
        }
      }

      return reply.send({ roomName: plan.roomName })
    } catch (error) {
      fastify.log.error(error, "Error starting chat call")
      return reply.code(500).send({ error: "Failed to start the call" })
    }
  })
}

export default chatRoutes
