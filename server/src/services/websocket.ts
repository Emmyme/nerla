import type { FastifyRequest } from "fastify"
import { db, meetingParticipants, users } from "../db"
import { eq, and } from "drizzle-orm"
import { z } from "zod"
import { COOKIE_NAME, cookieOriginAllowed } from "../utils/authCookie"
import { verifyAuthToken } from "./sessions"
import { canonicalRoom, foreignRoom } from "../utils/meetingRooms"
import { chatAudience, chatIdFor, threadOf, type ChatRef } from "../utils/chatAccess"
import { chatRef, displayName } from "./chats"
import { presenceCall, presenceClosed, presenceIdle, presenceOpened } from "./presence"
import { resolveOrg } from "./tenancy"
import { isRefusal } from "../utils/tenancy"
import { logger } from "../utils/logger"
import { live } from "../live/live"
import { errorText } from "../utils/errorText"

const typingSchema = z.object({
  type: z.literal("typing"),
  kind: z.enum(["dm", "group"]),
  chatId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
})

const TYPING_INTERVAL_MS = 2000
/** Signals a user may send per second across all chats, checked before any lookup */
const TYPING_BURST = 10
const TRACKED_MAX = 10000

/** When each user last had a typing signal relayed, per chat */
const typingSentAt = new Map<string, number>()
/** Each user's token bucket of typing signals */
const typingBuckets = new Map<string, { tokens: number; at: number }>()

/** Keeps a tracking map bounded: stale entries go first, then the oldest */
function bound<V>(map: Map<string, V>, stale: (value: V) => boolean) {
  if (map.size < TRACKED_MAX) return
  for (const [key, value] of map) if (stale(value)) map.delete(key)
  for (const key of map.keys()) {
    if (map.size < TRACKED_MAX) break
    map.delete(key)
  }
}

function typingTokenTaken(userId: string, now: number): boolean {
  const bucket = typingBuckets.get(userId) ?? { tokens: TYPING_BURST, at: now }
  const tokens = Math.min(TYPING_BURST, bucket.tokens + ((now - bucket.at) / 1000) * TYPING_BURST)
  typingBuckets.delete(userId)
  bound(typingBuckets, (entry) => now - entry.at >= 1000)
  typingBuckets.set(userId, { tokens: tokens >= 1 ? tokens - 1 : tokens, at: now })
  return tokens >= 1
}

function typingRelayAllowed(key: string, now: number): boolean {
  const last = typingSentAt.get(key)
  if (last !== undefined && now - last < TYPING_INTERVAL_MS) return false
  typingSentAt.delete(key)
  bound(typingSentAt, (at) => now - at >= TYPING_INTERVAL_MS)
  typingSentAt.set(key, now)
  return true
}

type WebSocketConnection = {
  socket: {
    send: (data: string) => void
    on(event: "message", handler: (raw: Buffer) => void): void
    on(event: "close", handler: () => void): void
    on(event: "error", handler: (error: Error) => void): void
    readyState: number
    close: (code?: number, reason?: string) => void
  }
}

const AUTH_TIMEOUT_MS = 5000
const PRE_AUTH_MAX_BYTES = 4096

/** Sockets outlive their token, so revocation is rechecked while open */
const REVALIDATE_INTERVAL_MS = 60_000

const presenceSchema = z.object({
  type: z.literal("presence"),
  state: z.enum(["idle", "active"]),
})

const callSchema = z.object({
  type: z.literal("call"),
  roomName: z.string().min(1).max(128).nullable(),
})

const declineSchema = z.object({
  type: z.literal("meeting-invite-declined"),
  targetUserId: z.string().uuid(),
  roomName: z.string().min(1).max(128),
})

interface AuthenticatedConnection {
  socket: WebSocketConnection["socket"]
  userId: string
  /** Looked up on the first typing signal */
  name?: string
  /** The user's workspace, resolved once per connection on first use */
  organizationId?: Promise<string | null>
  leave: () => void
}

const clients = new Map<WebSocketConnection["socket"], AuthenticatedConnection>()

/**
 * Every open socket of the user, other tabs and devices too. Every event goes out through here and
 * names its workspace, so a client drops events of a workspace it is not looking at
 */
export function sendToUser(organizationId: string, userId: string, data: Record<string, unknown>) {
  live.publish(`user:${userId}`, JSON.stringify({ ...data, organizationId }))
}

/** One event to everyone in a chat, each with the chat id they know it by */
export function emitToChat(organizationId: string, chat: ChatRef, type: string, payload: Record<string, unknown>, exceptUserId?: string) {
  for (const userId of chatAudience(threadOf(chat))) {
    if (userId === exceptUserId) continue
    sendToUser(organizationId, userId, { type, kind: chat.kind, chatId: chatIdFor(chat, userId), ...payload })
  }
}

/**
 * Desktop clients authenticate with a first message rather than a query-string
 * token, keeping the JWT out of access logs, history and Referrer headers
 */
export function handleWebSocket(socket: WebSocketConnection["socket"], req: FastifyRequest) {
  const fastify = req.server

  let authenticated = false
  let revalidateTimer: NodeJS.Timeout | null = null
  let authTimeout: NodeJS.Timeout | null = null

  const teardown = () => {
    if (revalidateTimer) clearInterval(revalidateTimer)
    const connection = clients.get(socket)
    if (connection) {
      connection.leave()
      clients.delete(socket)
      presenceClosed(socket, connection.userId)
    }
  }

  const accept = (token: string, session: { id: string }) => {
    // A second sign-in message, or one that finishes after the close, would leave a subscription nothing removes
    if (authenticated || socket.readyState !== WebSocket.OPEN) return
    authenticated = true
    if (authTimeout) clearTimeout(authTimeout)
    const connection: AuthenticatedConnection = {
      socket,
      userId: session.id,
      leave: live.subscribe(`user:${session.id}`, (message) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(message as string)
      }),
    }
    clients.set(socket, connection)
    presenceOpened(socket, session.id)

    revalidateTimer = setInterval(async () => {
      if (!(await verifyAuthToken(fastify, token))) {
        teardown()
        socket.close(1008, "Session revoked")
      }
    }, REVALIDATE_INTERVAL_MS)
    revalidateTimer.unref()

    // The client keeps the workspace it signed in to and drops events naming another one
    void connectionOrg(connection).then((organizationId) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "auth_success", organizationId }))
    })
  }

  // Listeners are registered synchronously so no message is dropped while this is in flight.
  // The handler awaits it before treating a socket as anonymous
  const cookieToken = req.cookies?.[COOKIE_NAME]
  const cookieAuth = cookieToken
    ? verifyAuthToken(fastify, cookieToken).then((session) => {
        if (!session || authenticated) return
        // Another site's page would send the cookie too, so the cookie counts only from Nerla's own pages
        if (!cookieOriginAllowed(req.headers.origin, req.host)) socket.close(4403, "Forbidden")
        else accept(cookieToken, session)
      })
    : Promise.resolve()

  authTimeout = setTimeout(() => {
    if (!authenticated) {
      socket.send(JSON.stringify({ type: "error", message: "Auth timeout" }))
      socket.close(1008, "Auth timeout")
    }
  }, AUTH_TIMEOUT_MS)

  socket.on("message", async (raw: Buffer) => {
    try {
      await cookieAuth
      if (socket.readyState !== WebSocket.OPEN) return
      // A sign-in message is small, so a stranger cannot make the server parse a large one
      if (!authenticated && raw.length > PRE_AUTH_MAX_BYTES) {
        socket.close(1009, "Message too big")
        return
      }
      const data = JSON.parse(raw.toString())

      if (!authenticated) {
        if (data.type !== "auth" || typeof data.token !== "string") {
          socket.close(1008, "Unauthorized")
          return
        }

        const session = await verifyAuthToken(fastify, data.token)
        if (!session) {
          socket.close(1008, "Invalid token")
          return
        }

        accept(data.token, session)
        return
      }

      await handleMessage(socket, data)
    } catch (error) {
      logger.warn("Handling a WebSocket message failed", { error: errorText(error) })
      socket.send(JSON.stringify({ error: "Invalid message format" }))
    }
  })

  socket.on("close", () => {
    if (authTimeout) clearTimeout(authTimeout)
    teardown()
  })

  socket.on("error", (error: Error) => {
    logger.warn("WebSocket error", { error: error.message })
  })
}

async function isMeetingParticipant(organizationId: string, roomName: string, userId: string): Promise<boolean> {
  const row = await db.query.meetingParticipants.findFirst({
    where: and(
      eq(meetingParticipants.roomName, roomName),
      eq(meetingParticipants.userId, userId),
      eq(meetingParticipants.organizationId, organizationId),
    ),
    columns: { userId: true },
  })
  return !!row
}

async function connectionOrg(connection: AuthenticatedConnection): Promise<string | null> {
  connection.organizationId ??= resolveOrg(connection.userId).then((org) => (isRefusal(org) ? null : org.organizationId))
  try {
    return await connection.organizationId
  } catch (error) {
    connection.organizationId = undefined
    logger.warn("Resolving a socket's workspace failed", { error: errorText(error) })
    return null
  }
}

async function handleMessage(socket: WebSocketConnection["socket"], data: { type?: unknown }) {
  const connection = clients.get(socket)
  if (!connection) return

  const { userId } = connection

  switch (data.type) {
    case "typing": {
      const parsed = typingSchema.safeParse(data)
      if (!parsed.success) return
      const { kind, chatId } = parsed.data
      const now = Date.now()
      if (!typingTokenTaken(userId, now)) return
      if (!typingRelayAllowed(`${userId}:${kind}:${chatId}`, now)) return
      const organizationId = await connectionOrg(connection)
      if (!organizationId) return
      const chat = await chatRef(organizationId, userId, kind, chatId)
      if (!chat) return
      connection.name ??= await displayName(userId)
      emitToChat(organizationId, chat, "typing", { userId, name: connection.name }, userId)
      break
    }

    case "presence": {
      const parsed = presenceSchema.safeParse(data)
      if (parsed.success) presenceIdle(socket, userId, parsed.data.state === "idle")
      break
    }

    case "call": {
      const parsed = callSchema.safeParse(data)
      if (!parsed.success) return
      const { roomName } = parsed.data
      await presenceCall(socket, userId, roomName === null ? null : canonicalRoom(roomName))
      break
    }

    case "meeting-invite-declined": {
      const parsed = declineSchema.safeParse(data)
      if (!parsed.success) return

      const roomName = canonicalRoom(parsed.data.roomName)
      const organizationId = await connectionOrg(connection)
      if (!organizationId || foreignRoom(roomName, organizationId)) return
      // Both parties must belong to the room, otherwise any user could spoof declines into arbitrary inboxes
      const [self, target] = await Promise.all([
        isMeetingParticipant(organizationId, roomName, userId),
        isMeetingParticipant(organizationId, roomName, parsed.data.targetUserId),
      ])
      if (!self || !target) return

      const decliner = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { firstName: true, lastName: true },
      })
      const name = decliner ? [decliner.firstName, decliner.lastName].filter(Boolean).join(" ").trim() || "Someone" : "Someone"

      sendToUser(organizationId, parsed.data.targetUserId, {
        type: "meeting-invite-declined",
        userId,
        name,
        roomName,
      })
      break
    }
  }
}

/** Tells the creator and guests of an event, or the whole workspace for Everyone events, to reload */
export function emitCalendarChanged(organizationId: string, userIds: Iterable<string>, eventId: string) {
  for (const userId of new Set(userIds)) sendToUser(organizationId, userId, { type: "calendar-changed", eventId })
}

export function emitMessageRead(organizationId: string, senderId: string, messageId: string) {
  sendToUser(organizationId, senderId, {
    type: "message-read",
    messageId,
  })
}
