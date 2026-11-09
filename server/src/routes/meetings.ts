import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { CLIENT_URL } from "../utils/clientUrl"
import { AccessToken, VideoGrant } from "livekit-server-sdk"
import { authMiddleware, bearerOf } from "../middleware/auth"
import { db, users, meetingParticipants } from "../db"
import { eq, and, inArray, isNotNull } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import {
  createGuestSession,
  getGuestSession,
  admitGuest,
  denyGuest,
  cancelGuest,
  guestSecretMatches,
  pendingFor,
  takeGuestToken,
} from "../services/guestSessions"
import { sendToUser } from "../services/websocket"
import { roomChangedLater } from "../services/presence"
import { logger } from "../utils/logger"
import { eventRoomAccess, eventRoomHosts, eventRoomState } from "../services/calendarQueries"
import { canonicalRoom, foreignRoom, instantRoom, roomKind } from "../utils/meetingRooms"
import { presenceName, roomPresence } from "../utils/presence"
import { directRoomAccess, dmPartner } from "../utils/roomAccess"
import { addParticipant, inRoom, roomService } from "../services/liveRooms"
import { callGuestClaims, signCallGuestPass } from "../utils/docCalls"
import { chatCallAccess, chatCallRoom } from "../services/chats"
import { isMemberOf, membersOf, orgMiddleware, orgOf, resolveOrgs } from "../services/tenancy"
import { isRefusal } from "../utils/tenancy"
import { UUID } from "../utils/uuid"
import { livekitPublicUrl } from "../utils/livekitUrl"
import { tooManyRequests } from "./helpers"
import { errorText } from "../utils/errorText"

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || ""
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || ""
const LIVEKIT_PUBLIC_URL = livekitPublicUrl(process.env.LIVEKIT_PUBLIC_URL)

function validRoomName(roomName: unknown): roomName is string {
  return !!roomName && typeof roomName === "string" && roomName.length <= 128 && roomKind(roomName).kind !== "invalid"
}

/** Another workspace's room answers like a missing one, before any of its rows are read */
const ROOM_NOT_FOUND = { error: "This meeting does not exist" }
const BAD_ROOM = { error: "Invalid room name" }
const NOT_INVITED = { error: "You have not been invited to this meeting" }
const SESSION_RESOLVED = { error: "Session not found or already resolved" }

type RoomVerdict = "allowed" | "denied" | "missing"

/**
 * Tokens only open the door. LiveKit sends a connected participant a fresh token when the session
 * starts and every five minutes after, and the client reconnects with it, so a short lifetime never
 * ends a call. A copied guest token is useless once it lapses, and a member fetches theirs at Join.
 */
const GUEST_TOKEN_TTL = guestTokenTtl()
const MEMBER_TOKEN_TTL = "10m"
/** About how long a guest takes to connect after getting a token */
const GUEST_JOIN_CHECK_MS = 5000

/** Five minutes, shortened only for live checks through LIVEKIT_GUEST_TTL, such as "20s". Never longer, never in production */
function guestTokenTtl(): string {
  const set = process.env.LIVEKIT_GUEST_TTL?.trim()
  const match = set && process.env.NODE_ENV !== "production" ? /^(\d+)([sm])$/.exec(set) : null
  const seconds = match ? Number(match[1]) * (match[2] === "m" ? 60 : 1) : 0
  return seconds > 0 && seconds < 5 * 60 ? `${seconds}s` : "5m"
}

async function createLiveKitToken(identity: string, name: string, roomName: string, metadata: string, ttl: string): Promise<string> {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name,
    metadata,
    ttl,
  })
  const grant: VideoGrant = {
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  }
  at.addGrant(grant)
  return at.toJwt()
}

/** Only for payloads that stay inside the workspace, since it falls back to the email */
function fullName(user: { firstName: string | null; lastName: string | null; email: string }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email
}

/** What a member sees as the call's name: the series title, the other user of a 1:1 call, the group of a chat call, else "Meeting". */
async function roomTitle(userId: string, organizationId: string, roomName: string): Promise<string> {
  const room = roomKind(roomName)
  if (room.kind === "scheduled") {
    const state = await eventRoomState(room.eventId, organizationId)
    return state && state.masterId === room.eventId ? state.title : "Meeting"
  }
  if (room.kind === "dm") {
    const otherId = dmPartner(userId, room)
    if (!otherId || !(await isMemberOf(otherId, organizationId))) return "Meeting"
    const other = await db.query.users.findFirst({ where: eq(users.id, otherId) })
    return [other?.firstName, other?.lastName].filter(Boolean).join(" ").trim() || "Meeting"
  }
  const call = await chatCallRoom(roomName)
  return call && call.organizationId === organizationId ? call.name : "Meeting"
}

/** A guest may only knock on a room that exists: a series master, or an instant room a user opened. */
async function guestRoomExists(roomName: string): Promise<boolean> {
  const room = roomKind(roomName)
  if (room.kind === "dm") return false
  if (room.kind === "scheduled") {
    const state = await eventRoomState(room.eventId)
    return !!state && state.masterId === room.eventId
  }
  if (room.kind !== "instant") return false
  // tenancy: a guest has no workspace, and the answer only says whether a random room name is open
  const row = await db.query.meetingParticipants.findFirst({
    where: eq(meetingParticipants.roomName, roomName),
    columns: { userId: true },
  })
  return !!row
}

async function isParticipant(organizationId: string, userId: string, roomName: string): Promise<boolean> {
  const row = await db.query.meetingParticipants.findFirst({
    where: and(
      eq(meetingParticipants.roomName, roomName),
      eq(meetingParticipants.userId, userId),
      eq(meetingParticipants.organizationId, organizationId),
    ),
  })
  return !!row
}

async function wasInvitedInCall(organizationId: string, userId: string, roomName: string): Promise<boolean> {
  const row = await db.query.meetingParticipants.findFirst({
    where: and(
      eq(meetingParticipants.roomName, roomName),
      eq(meetingParticipants.userId, userId),
      isNotNull(meetingParticipants.invitedBy),
      eq(meetingParticipants.organizationId, organizationId),
    ),
  })
  return !!row
}

/**
 * A scheduled room follows its event, so a guest who is removed loses access. Users invited from
 * inside the call keep theirs while the event still has a video call. Only the series id names the
 * room, so an occurrence's own id never opens a second room that removals would not reach.
 */
async function scheduledRoomAccess(userId: string, organizationId: string, roomName: string, eventId: string) {
  const room = await eventRoomState(eventId, organizationId)
  if (!room || room.masterId !== eventId) return false
  if (await eventRoomAccess(userId, organizationId, eventId)) return true
  return room.video && (await wasInvitedInCall(organizationId, userId, roomName))
}

/**
 * Seeds participant rows for the cases that define their own membership: 1:1
 * calls, the creator and guests of a scheduled meeting, whoever opens a brand-new room,
 * and a current member of the group chat a call was posted in. A room another workspace holds, and a room
 * nobody opened, answer "missing" so they look like a name that does not exist.
 */
async function ensureRoomAccess(userId: string, organizationId: string, roomName: string): Promise<RoomVerdict> {
  const room = roomKind(roomName)
  if (room.kind === "scheduled") {
    if (!(await scheduledRoomAccess(userId, organizationId, roomName, room.eventId))) return "denied"
    await addParticipant(organizationId, roomName, userId, null)
    return "allowed"
  }

  // tenancy: room ownership check, every row is read so a room another workspace holds never looks empty
  const all = await db.query.meetingParticipants.findMany({
    where: eq(meetingParticipants.roomName, roomName),
    columns: { userId: true, invitedBy: true, organizationId: true },
  })
  const taken = all.some((row) => row.organizationId !== organizationId)
  const rows = all.filter((row) => row.organizationId === organizationId)

  // A group chat's call follows the group as it is now, never the rows seeded when the call started
  const call = room.kind === "instant" ? await chatCallRoom(roomName) : null
  if (call) {
    if (taken || call.organizationId !== organizationId) return "missing"
    const allowed = await chatCallAccess(userId, organizationId, call, rows)
    if (allowed) await addParticipant(organizationId, roomName, userId, null)
    return allowed ? "allowed" : "denied"
  }

  const inviter = rows.find((row) => row.userId === userId)?.invitedBy
  const ids = room.kind === "dm" ? [room.a, room.b, ...(inviter ? [inviter] : [])] : []
  const members = await membersOf(organizationId, ids)
  const inOrg = new Set([...members].map((id) => id.toLowerCase()))

  const access = directRoomAccess(userId, roomName, { rows, taken, inOrg: (id) => inOrg.has(id.toLowerCase()) })
  for (const id of access.seed) await addParticipant(organizationId, roomName, id, null)
  return access.allowed ? "allowed" : access.missing ? "missing" : "denied"
}

/** Who may admit or deny guests: anyone with access to a scheduled room, else its participants. */
async function canHostRoom(organizationId: string, userId: string, roomName: string): Promise<boolean> {
  const room = roomKind(roomName)
  const call = room.kind === "instant" ? await chatCallRoom(roomName) : null
  if (room.kind !== "scheduled" && !call) {
    // tenancy: room ownership check, every row is read so a room another workspace also holds is never hosted
    const all = await db.query.meetingParticipants.findMany({
      where: eq(meetingParticipants.roomName, roomName),
      columns: { userId: true, organizationId: true },
    })
    if (all.some((row) => row.organizationId !== organizationId)) return false
    return all.some((row) => row.userId === userId)
  }
  if (call) {
    if (!(await isParticipant(organizationId, userId, roomName))) return false
    const rows = await db.query.meetingParticipants.findMany({
      where: and(eq(meetingParticipants.roomName, roomName), eq(meetingParticipants.organizationId, organizationId)),
      columns: { userId: true, invitedBy: true },
    })
    return chatCallAccess(userId, organizationId, call, rows)
  }
  if (room.kind !== "scheduled") return false
  return scheduledRoomAccess(userId, organizationId, roomName, room.eventId)
}

/**
 * A scheduled room's creator and guests hear about waiting guests even before anyone has joined.
 * Its other participants count only when invited in the call, or when any member may enter.
 * Each host hears it in the workspace of the event, or of their participant row. A room whose rows
 * span two workspaces has no hosts, the same as it lets nobody in.
 */
async function lobbyHosts(roomName: string): Promise<Map<string, string>> {
  const room = roomKind(roomName)
  const event = room.kind === "scheduled" ? await eventRoomHosts(room.eventId) : { hosts: [], everyone: true, organizationId: null }
  // tenancy: the guest lobby has no workspace, so the room name alone decides who hears a knock
  const all = await db.query.meetingParticipants.findMany({
    where: eq(meetingParticipants.roomName, roomName),
    columns: { userId: true, organizationId: true, invitedBy: true },
  })
  const rowOrgs = new Set([event.organizationId, ...all.map((row) => row.organizationId)].filter(Boolean))
  if (rowOrgs.size > 1) return new Map()
  const participants = event.everyone ? all : all.filter((row) => row.invitedBy !== null)
  const hosts = new Map<string, string | null>(event.hosts.map((id) => [id, event.organizationId]))
  for (const row of participants) if (!hosts.get(row.userId)) hosts.set(row.userId, row.organizationId)
  const unknown = [...hosts].filter(([, org]) => !org).map(([id]) => id)
  if (unknown.length) for (const [id, org] of await resolveOrgs(unknown)) hosts.set(id, isRefusal(org) ? null : org.organizationId)
  const resolved = new Map([...hosts].filter((entry): entry is [string, string] => !!entry[1]))
  return new Set(resolved.values()).size > 1 ? new Map() : resolved
}

async function notifyLobbyResolved(roomName: string, sessionId: string, outcome: "admitted" | "denied" | "cancelled") {
  for (const [userId, organizationId] of await lobbyHosts(roomName)) {
    sendToUser(organizationId, userId, { type: "lobby-resolved", roomName, sessionId, outcome })
  }
}

// Route config, not a preHandler: the global limiter marks every request as counted, so a preHandler limit never fires
const guestRequestRateLimit = {
  max: 5,
  timeWindow: "1 minute" as const,
  keyGenerator: (request: { ip: string }) => request.ip,
  errorResponseBuilder: tooManyRequests("Too many guest requests. Please wait before trying again."),
}

// A guest in a call refreshes their pass every five minutes, so this budget only stops guessing
const guestPassRateLimit = {
  ...guestRequestRateLimit,
  max: 30,
  errorResponseBuilder: tooManyRequests("Too many pass refreshes. Please wait before trying again."),
}

// Cancel has its own looser budget, so a closing tab's cancel is never starved
const guestCancelRateLimit = {
  ...guestRequestRateLimit,
  max: 30,
  errorResponseBuilder: tooManyRequests("Too many cancel requests. Please wait before trying again."),
}

async function meetingRoutes(fastify: FastifyInstance) {
  fastify.post("/token", { preHandler: [authMiddleware, orgMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const roomName = canonicalRoom((request.body as { roomName?: string } | undefined)?.roomName)

    // Instant rooms carry a random id, so nobody opens a guessable room like "standup"
    if (!validRoomName(roomName)) {
      return reply.status(400).send(BAD_ROOM)
    }

    const { organizationId } = orgOf(request)
    if (foreignRoom(roomName, organizationId)) return reply.status(404).send(ROOM_NOT_FOUND)
    const access = await ensureRoomAccess(user.id, organizationId, roomName)
    if (access === "missing") return reply.status(404).send(ROOM_NOT_FOUND)
    if (access === "denied") {
      return reply.status(403).send(NOT_INVITED)
    }

    // Guests read this name on tiles and in chat, so it never falls back to the email
    const userRecord = await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { firstName: true, lastName: true },
    })
    const displayName = presenceName(userRecord?.firstName ?? null, userRecord?.lastName ?? null)

    const token = await createLiveKitToken(user.id, displayName, roomName, JSON.stringify({ role: "member" }), MEMBER_TOKEN_TTL)
    const title = await roomTitle(user.id, organizationId, roomName)

    return reply.send({ token, livekitUrl: LIVEKIT_PUBLIC_URL, title })
  })

  /** Who is already in the call, for the pre-join. Members with access only, so names never reach guests. */
  fastify.get("/presence", { preHandler: [authMiddleware, orgMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const roomName = canonicalRoom((request.query as { roomName?: unknown } | undefined)?.roomName)
    if (!validRoomName(roomName)) {
      return reply.status(400).send(BAD_ROOM)
    }

    if (foreignRoom(roomName, orgOf(request).organizationId)) return reply.status(404).send(ROOM_NOT_FOUND)
    const access = await ensureRoomAccess(user.id, orgOf(request).organizationId, roomName)
    if (access === "missing") return reply.status(404).send(ROOM_NOT_FOUND)
    if (access === "denied") {
      return reply.status(403).send(NOT_INVITED)
    }

    let participants: { identity: string; metadata?: string }[] = []
    try {
      participants = await roomService.listParticipants(roomName)
    } catch (err) {
      // A room nobody has opened yet does not exist on the LiveKit side
      if ((err as { status?: number }).status !== 404) {
        logger.warn("Meeting presence lookup failed", { error: errorText(err) })
        return reply.status(503).send({ error: "Presence is unavailable" })
      }
    }

    // Egress, agents and SIP join under their own identities, which are not user ids
    const ids = [...new Set(participants.map((p) => p.identity))].filter((id) => UUID.test(id))
    const rows = ids.length
      ? await db.query.users.findMany({
          where: inArray(users.id, ids),
          columns: { id: true, firstName: true, lastName: true },
        })
      : []
    const names = new Map(rows.map((row) => [row.id, presenceName(row.firstName, row.lastName)]))
    return roomPresence(participants, user.id, names)
  })

  /** Meet now: a fresh room with the caller as its first participant, and a link to share. */
  fastify.post("/instant", { preHandler: [authMiddleware, orgMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const { organizationId } = orgOf(request)
    const roomName = instantRoom(organizationId)
    await addParticipant(organizationId, roomName, user.id, null)
    return reply.status(201).send({ roomName, joinUrl: `${CLIENT_URL}/join/${roomName}` })
  })

  /** Guests already waiting, for a host who arrives after their request went out. */
  fastify.get("/lobby", { preHandler: [authMiddleware, orgMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const roomName = canonicalRoom((request.query as { roomName?: unknown } | undefined)?.roomName)

    if (!validRoomName(roomName)) {
      return reply.status(400).send(BAD_ROOM)
    }
    if (foreignRoom(roomName, orgOf(request).organizationId)) return reply.status(404).send(ROOM_NOT_FOUND)
    if (!(await canHostRoom(orgOf(request).organizationId, user.id, roomName))) {
      return reply.status(403).send({ error: "Only meeting participants can see the lobby" })
    }

    return pendingFor(roomName)
  })

  fastify.post("/invite", { preHandler: [authMiddleware, orgMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const body = (request.body ?? {}) as { roomName?: unknown; targetUserId?: unknown }
    const roomName = canonicalRoom(body.roomName)
    const { targetUserId } = body

    if (!validRoomName(roomName) || typeof targetUserId !== "string" || !UUID.test(targetUserId)) {
      return reply.status(400).send({ error: "roomName and targetUserId are required" })
    }
    if (targetUserId.toLowerCase() === user.id.toLowerCase()) {
      return reply.status(400).send({ error: "You cannot invite yourself" })
    }

    const callerMembership = orgOf(request)
    if (foreignRoom(roomName, callerMembership.organizationId)) return reply.status(404).send(ROOM_NOT_FOUND)
    const callerAccess = await ensureRoomAccess(user.id, callerMembership.organizationId, roomName)
    if (callerAccess === "missing") return reply.status(404).send(ROOM_NOT_FOUND)
    if (callerAccess === "denied") {
      return reply.status(403).send({ error: "You are not a participant of this meeting" })
    }
    // An in-call invite outlives the guest list, so only the event's own people may hand one out
    const room = roomKind(roomName)
    if (room.kind === "scheduled" && !(await eventRoomAccess(user.id, callerMembership.organizationId, room.eventId))) {
      return reply.status(403).send({ error: "Only the organizer and guests can invite people to this meeting" })
    }

    if (!(await isMemberOf(targetUserId, callerMembership.organizationId))) {
      return reply.status(404).send({ error: "User not found" })
    }

    await addParticipant(callerMembership.organizationId, roomName, targetUserId, user.id)

    const caller = await db.query.users.findFirst({
      where: eq(users.id, user.id),
    })
    const callerName = caller ? fullName(caller) : user.email
    const title = await roomTitle(targetUserId, callerMembership.organizationId, roomName)

    sendToUser(callerMembership.organizationId, targetUserId, {
      type: "meeting-invite",
      roomName,
      title,
      callerName,
      callerEmail: user.email,
      callerId: user.id,
    })

    return reply.send({ message: "Invitation sent" })
  })

  fastify.post("/guest-request", { config: { rateLimit: guestRequestRateLimit } }, async (request: FastifyRequest, reply: FastifyReply) => {
    // A guest gives only a name, any other field is ignored
    const { roomName: rawRoom, name: rawName } = (request.body ?? {}) as { roomName?: unknown; name?: unknown }
    const roomName = canonicalRoom(rawRoom)
    const name = typeof rawName === "string" ? rawName.trim() : rawName

    if (!roomName || !name) {
      return reply.status(400).send({ error: "roomName and name are required" })
    }

    if (!validRoomName(roomName) || typeof name !== "string" || name.length > 100) {
      return reply.status(400).send({ error: "Invalid input" })
    }

    if (!(await guestRoomExists(roomName))) {
      return reply.status(404).send(ROOM_NOT_FOUND)
    }

    const session = await createGuestSession(name, roomName)

    for (const [userId, organizationId] of await lobbyHosts(roomName)) {
      sendToUser(organizationId, userId, {
        type: "lobby-request",
        guestName: name,
        sessionId: session.id,
        roomName,
      })
    }

    // Hosts get the session id to admit or deny, only the guest gets the secret that reads the outcome
    return reply.status(201).send({ sessionId: session.id, secret: session.secret })
  })

  /** The guest stopped waiting, so the hosts' lobby drops the request. The secret travels in the body, since a beacon sends no headers. */
  fastify.post("/guest-cancel", { config: { rateLimit: guestCancelRateLimit } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId, secret } = (request.body ?? {}) as { sessionId?: unknown; secret?: unknown }
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 64 || typeof secret !== "string") {
      return reply.status(400).send({ error: "sessionId and secret are required" })
    }

    const roomName = await cancelGuest(sessionId, secret)
    if (!roomName) {
      return reply.status(404).send(SESSION_RESOLVED)
    }

    await notifyLobbyResolved(roomName, sessionId, "cancelled")
    return reply.send({ message: "Request cancelled" })
  })

  fastify.get("/guest-status/:sessionId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = request.params as { sessionId: string }
    const secret = request.headers["x-guest-secret"]
    const session = await getGuestSession(sessionId)
    // The body can carry a LiveKit token, so no cache keeps it
    reply.header("Cache-Control", "no-store")

    // A wrong secret looks the same as a missing session
    if (!session || !(await guestSecretMatches(sessionId, secret))) {
      return reply.status(404).send({ error: "Session not found or expired" })
    }

    const response: {
      status: string
      token?: string
      livekitUrl?: string | null
      pass?: string
      passExpiresAt?: string
    } = { status: session.status }
    const token = await takeGuestToken(sessionId, secret)
    if (token) {
      response.token = token
      response.livekitUrl = LIVEKIT_PUBLIC_URL
      roomChangedLater(session.roomName, GUEST_JOIN_CHECK_MS)
      // The LiveKit token lapses within minutes, the pass is what proves the guest to Nerla during the call
      if (session.identity) {
        const pass = signCallGuestPass(
          { roomName: session.roomName, identity: session.identity, name: `${session.name} (Guest)` },
          new Date(),
        )
        response.pass = pass.token
        response.passExpiresAt = pass.expiresAt.toISOString()
      }
    }

    return reply.send(response)
  })

  /** A fresh call pass for a guest whose pass still holds and who is still in its call */
  fastify.post(
    "/guest-pass/refresh",
    { config: { rateLimit: guestPassRateLimit } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("Cache-Control", "no-store")
      const held = bearerOf(request)
      const now = new Date()
      const claims = held ? callGuestClaims(held, now) : null
      if (!claims || !(await inRoom(claims.roomName, claims.identity))) {
        return reply.status(404).send({ error: "Pass not found or expired" })
      }
      const pass = signCallGuestPass(claims, now)
      return reply.send({ pass: pass.token, passExpiresAt: pass.expiresAt.toISOString() })
    },
  )

  // Admitting a wrong-room session would let an org member hijack another room's lobby
  fastify.post("/guest-admit", { preHandler: [authMiddleware, orgMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const { sessionId, roomName: rawRoom } = (request.body ?? {}) as { sessionId?: unknown; roomName?: unknown }
    const roomName = canonicalRoom(rawRoom)

    if (typeof sessionId !== "string" || !sessionId || !validRoomName(roomName)) {
      return reply.status(400).send({ error: "sessionId and roomName are required" })
    }

    if (foreignRoom(roomName, orgOf(request).organizationId)) return reply.status(404).send(ROOM_NOT_FOUND)
    if (!(await canHostRoom(orgOf(request).organizationId, user.id, roomName))) {
      return reply.status(403).send({ error: "Only meeting participants can admit guests" })
    }

    const session = await getGuestSession(sessionId)
    if (!session || session.status !== "pending") {
      return reply.status(404).send(SESSION_RESOLVED)
    }

    if (session.roomName !== roomName) {
      return reply.status(403).send({ error: "Room mismatch - you can only admit guests to your own room" })
    }

    // Everyone in the call can read identities and metadata, so neither carries the session id or an email
    const identity = `guest-${randomUUID()}`
    const token = await createLiveKitToken(
      identity,
      `${session.name} (Guest)`,
      session.roomName,
      JSON.stringify({ role: "guest" }),
      GUEST_TOKEN_TTL,
    )

    // The guest may have cancelled while the token was signed
    if (!(await admitGuest(sessionId, token, identity))) {
      return reply.status(404).send(SESSION_RESOLVED)
    }
    await notifyLobbyResolved(roomName, sessionId, "admitted")
    return reply.send({ message: "Guest admitted" })
  })

  fastify.post("/guest-deny", { preHandler: [authMiddleware, orgMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const { sessionId, roomName: rawRoom } = (request.body ?? {}) as { sessionId?: unknown; roomName?: unknown }
    const roomName = canonicalRoom(rawRoom)

    if (typeof sessionId !== "string" || !sessionId || !validRoomName(roomName)) {
      return reply.status(400).send({ error: "sessionId and roomName are required" })
    }

    if (foreignRoom(roomName, orgOf(request).organizationId)) return reply.status(404).send(ROOM_NOT_FOUND)
    if (!(await canHostRoom(orgOf(request).organizationId, user.id, roomName))) {
      return reply.status(403).send({ error: "Only meeting participants can deny guests" })
    }

    const session = await getGuestSession(sessionId)
    if (!session || session.status !== "pending") {
      return reply.status(404).send(SESSION_RESOLVED)
    }

    if (session.roomName !== roomName) {
      return reply.status(403).send({ error: "Room mismatch" })
    }

    if (!(await denyGuest(sessionId))) {
      return reply.status(404).send(SESSION_RESOLVED)
    }
    await notifyLobbyResolved(roomName, sessionId, "denied")
    return reply.send({ message: "Guest denied" })
  })
}

export default meetingRoutes
