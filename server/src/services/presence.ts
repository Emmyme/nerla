import { randomInt } from "crypto"
import { and, eq, gt, isNotNull, lte, sql } from "drizzle-orm"
import { db, meetingParticipants, messages, users } from "../db"
import { defineJob } from "../jobs/queue"
import { activeStatus, loadedStatusApplies, presenceSeenBy, statusExpired, statusRetryMs, type Status } from "../utils/statusOverride"
import { logger } from "../utils/logger"
import { inRoom, participantCount } from "./liveRooms"
import { resolveOrg } from "./tenancy"
import { emitToChat, sendToUser } from "./websocket"
import { chatCallRoom, groupMemberIds } from "./chats"
import { live } from "../live/live"
import { isRefusal } from "../utils/tenancy"
import { CALL_GRACE_MS, serverInstant } from "../utils/chatAccess"
import { errorText } from "../utils/errorText"

type LivePresence = { online: boolean; idle: boolean; inCall: boolean }

type Connection = { idle: boolean; call: string | null; checkedAt: number }
type Heard = { self: string; others: string }
type Person = {
  organizationId: string | null
  connections: Map<object, Connection>
  /** Membership and the chosen status are loaded, so nothing goes out before them */
  loaded: boolean
  /** What the user and the rest of the organization last heard */
  sent: Heard
  timer?: NodeJS.Timeout
  leave?: () => void
}

const OFFLINE: LivePresence = { online: false, idle: false, inCall: false }
// Changes settle before they go out, and going offline waits longer so a reload or a reconnect never flickers
const SETTLE_MS = 1500
const OFFLINE_SETTLE_MS = 6000
const CALENDAR_SETTLE_MS = 1000
const CALENDAR_JITTER_MS = 4000
const CALL_CHECK_MS = 3000

const people = new Map<string, Person>()
const calendarPending = new Set<string>()
/** Chosen statuses that have not ended, for the users the server has heard of */
const statuses = new Map<string, Status>()
/** Bumped on every change of a user's status, so a database read that started earlier never overwrites it */
const versions = new Map<string, number>()
const versionOf = (userId: string) => versions.get(userId) ?? 0
const bump = (userId: string) => versions.set(userId, versionOf(userId) + 1)

function liveOf(person: Person | undefined): LivePresence {
  if (!person || person.connections.size === 0) return OFFLINE
  const all = [...person.connections.values()]
  return { online: true, idle: all.every((c) => c.idle), inCall: all.some((c) => c.call !== null) }
}

export function livePresence(userId: string): LivePresence {
  return liveOf(people.get(userId))
}

/** The chosen status while it lasts. One that has ended is dropped here */
function currentStatus(userId: string): Status | null {
  const status = statuses.get(userId)
  if (status?.until && Date.parse(status.until) <= Date.now()) {
    statuses.delete(userId)
    return null
  }
  return status ?? null
}

type OrgNews = { data: Record<string, unknown>; exceptUserId?: string }

/** Every connected member of the organization, apart from one */
function sendToOrganization(organizationId: string, data: Record<string, unknown>, exceptUserId?: string) {
  live.publish(`org:${organizationId}`, { data, exceptUserId } satisfies OrgNews)
}

/** A loaded user hears their organization until their last connection has settled offline */
function hearOrganization(userId: string, organizationId: string): () => void {
  return live.subscribe(`org:${organizationId}`, (news) => {
    const { data, exceptUserId } = news as OrgNews
    if (userId !== exceptUserId) sendToUser(organizationId, userId, data)
  })
}

function heard(userId: string, presence: LivePresence, status: Status | null): Heard {
  return {
    self: JSON.stringify({ type: "presence", userId, ...presenceSeenBy(presence, status, true) }),
    others: JSON.stringify({ type: "presence", userId, ...presenceSeenBy(presence, status, false) }),
  }
}

function lastHeard(userId: string, fallback: Status | null): Heard {
  const person = people.get(userId)
  return person?.loaded ? person.sent : heard(userId, liveOf(person), fallback)
}

/** A secret hides the calendar from others, so they ask again whenever one starts or stops showing */
const secretShown = (heard: string) => heard !== "" && JSON.parse(heard).status?.value === "secret"

/** The user and the rest of the organization each hear only what changed for them, so appear offline never leaks a move */
function announce(userId: string, organizationId: string | null, before: Heard) {
  const after = heard(userId, liveOf(people.get(userId)), currentStatus(userId))
  if (organizationId) {
    if (after.self !== before.self) sendToUser(organizationId, userId, JSON.parse(after.self))
    if (after.others !== before.others) sendToOrganization(organizationId, JSON.parse(after.others), userId)
    if (secretShown(after.others) !== secretShown(before.others)) calendarPresenceChanged(organizationId, [userId])
  }
  const person = people.get(userId)
  if (person?.loaded) person.sent = after
}

function settle(userId: string) {
  const person = people.get(userId)
  if (!person) return
  person.timer = undefined
  if (!person.loaded) return
  announce(userId, person.organizationId, person.sent)
  if (person.connections.size > 0) return
  person.leave?.()
  people.delete(userId)
}

function changed(userId: string) {
  const person = people.get(userId)
  if (!person?.loaded) return
  clearTimeout(person.timer)
  person.timer = setTimeout(() => settle(userId), person.connections.size > 0 ? SETTLE_MS : OFFLINE_SETTLE_MS)
  person.timer.unref()
}

async function clearExpired(userId: string) {
  try {
    await db
      .update(users)
      .set({ statusOverride: null, statusUntil: null })
      .where(and(eq(users.id, userId), isNotNull(users.statusUntil), lte(users.statusUntil, new Date())))
  } catch (error) {
    logger.warn("Clearing an ended status failed", { error: errorText(error) })
  }
}

/** Clears stored statuses that have ended, as a read comes across them */
export function statusesEnded(userIds: string[]) {
  for (const userId of userIds) void clearExpired(userId)
}

/** A new choice, already stored, goes out like a live change. Null means automatic */
export function statusChanged(userId: string, organizationId: string, status: Status | null, previous: Status | null) {
  const before = lastHeard(userId, previous)
  bump(userId)
  if (status) statuses.set(userId, status)
  else statuses.delete(userId)
  announce(userId, people.get(userId)?.organizationId ?? organizationId, before)
}

type StatusClear = Status & { userId: string; organizationId: string; until: string }

/** Ends a status at its time, unless it was changed since. The route that sets a status adds this job */
defineJob<StatusClear>("status.clear", {}, async ({ userId, organizationId, value, until }) => {
  const cleared = await db
    .update(users)
    .set({ statusOverride: null, statusUntil: null })
    .where(and(eq(users.id, userId), eq(users.statusUntil, new Date(until))))
    .returning({ id: users.id })
  // A read may have cleared the ended status first, and whoever sees it still needs to hear
  if (cleared.length > 0 || statuses.get(userId)?.until === until) statusChanged(userId, organizationId, null, { value, until })
})

/**
 * Loads a newly connected user's workspace and stored status. Until both are known nothing about them goes out,
 * and a failed read is tried again rather than taken as no choice
 */
function loadPerson(userId: string, person: Person, attempt = 0) {
  const version = versionOf(userId)
  Promise.all([
    resolveOrg(userId),
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { statusOverride: true, statusUntil: true } }),
  ])
    .then(
      ([org, row]) => {
        if (people.get(userId) !== person) return
        person.organizationId = isRefusal(org) ? null : org.organizationId
        if (person.organizationId) person.leave = hearOrganization(userId, person.organizationId)
        const now = Date.now()
        if (loadedStatusApplies(version, versionOf(userId))) {
          const status = activeStatus(row?.statusOverride, row?.statusUntil, now)
          const known = statuses.get(userId)
          if (!status) statuses.delete(userId)
          else if (known?.value !== status.value || known?.until !== status.until) statuses.set(userId, status)
        }
        if (statusExpired(row?.statusOverride, row?.statusUntil, now)) void clearExpired(userId)
        person.sent = heard(userId, OFFLINE, currentStatus(userId))
        person.loaded = true
        changed(userId)
      },
      (error: unknown) => {
        if (people.get(userId) !== person) return
        if (person.connections.size === 0) {
          people.delete(userId)
          return
        }
        logger.warn("Loading a person's status failed, trying again", { error: errorText(error) })
        setTimeout(() => loadPerson(userId, person, attempt + 1), statusRetryMs(attempt)).unref()
      },
    )
    .catch((error: unknown) => logger.warn("Applying a person's status failed", { error: errorText(error) }))
}

export function presenceOpened(socket: object, userId: string) {
  let person = people.get(userId)
  if (!person) {
    const created: Person = { organizationId: null, connections: new Map(), loaded: false, sent: { self: "", others: "" } }
    people.set(userId, created)
    person = created
    loadPerson(userId, created)
  }
  person.connections.set(socket, { idle: false, call: null, checkedAt: 0 })
  changed(userId)
}

export function presenceClosed(socket: object, userId: string) {
  const person = people.get(userId)
  const call = person?.connections.get(socket)?.call
  if (!person?.connections.delete(socket)) return
  changed(userId)
  if (call) void roomChanged(call)
}

/** The last count each room told its users, so only a change goes out */
const roomCounts = new Map<string, number>()
const ROOM_RECHECK_MS = 30_000
/** One recheck timer per room while users are in it */
const roomTimers = new Map<string, NodeJS.Timeout>()
const roomOnce = new Set<NodeJS.Timeout>()
let stopped = false

function armRoom(roomName: string) {
  if (stopped) return
  clearTimeout(roomTimers.get(roomName))
  const timer = setTimeout(() => void roomChanged(roomName), ROOM_RECHECK_MS)
  timer.unref()
  roomTimers.set(roomName, timer)
}

/** Stops every room timer, for shutdown */
export function stopRoomTimers() {
  stopped = true
  for (const timer of [...roomTimers.values(), ...roomOnce]) clearTimeout(timer)
  roomTimers.clear()
  roomOnce.clear()
}

/** One push for the room after a delay, sent whatever the count is */
export function roomChangedLater(roomName: string, delayMs: number) {
  if (stopped) return
  const timer = setTimeout(() => {
    roomOnce.delete(timer)
    void roomChanged(roomName, true)
  }, delayMs)
  timer.unref()
  roomOnce.add(timer)
}

/** Calls posted before a restart lost their end-of-grace push, so each gets one again */
export async function rescheduleCallGraces() {
  const cutoff = new Date(Date.now() - CALL_GRACE_MS).toISOString()
  // tenancy: a restart reschedules every workspace's rooms, and the push goes to each row's own workspace
  const rows = await db
    .select({ roomName: sql<string>`${messages.meta}->>'roomName'`, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.kind, "call"), gt(messages.createdAt, cutoff)))
  for (const row of rows)
    if (row.roomName) roomChangedLater(row.roomName, Math.max(0, serverInstant(row.createdAt) + CALL_GRACE_MS + 1000 - Date.now()))
}

/** Tells the users who may enter a room how many are in it now, and keeps asking LiveKit every 30 s while anyone is in it */
async function roomChanged(roomName: string, force = false) {
  if (stopped) return
  clearTimeout(roomTimers.get(roomName))
  roomTimers.delete(roomName)
  try {
    const count = await participantCount(roomName)
    if (count === null) {
      logger.warn("LiveKit gave no count for a call room", { roomName })
      if (roomCounts.has(roomName)) armRoom(roomName)
      return
    }
    if (count > 0) armRoom(roomName)
    if (!force && (roomCounts.get(roomName) ?? 0) === count) return
    const event = { type: "room-presence", roomName, count }
    const call = await chatCallRoom(roomName)
    const told = new Set<string>()
    if (call) {
      const memberIds = await groupMemberIds(call.groupChatId)
      emitToChat(call.organizationId, { kind: "group", id: call.groupChatId, memberIds }, "room-presence", { roomName, count })
      for (const id of memberIds) told.add(id)
    }
    // tenancy: a room has no workspace of its own, each row tells its user in the workspace of that row
    const rows = await db.select().from(meetingParticipants).where(eq(meetingParticipants.roomName, roomName))
    for (const row of rows) if (!told.has(row.userId)) sendToUser(row.organizationId, row.userId, event)
    if (count === 0) roomCounts.delete(roomName)
    else roomCounts.set(roomName, count)
  } catch (error) {
    logger.warn("Telling a call's users about its count failed", { error: errorText(error) })
    if (!roomTimers.has(roomName)) armRoom(roomName)
  }
}

/** Idle once the window has gone untouched or hidden for a while, active again on input */
export function presenceIdle(socket: object, userId: string, idle: boolean) {
  const connection = people.get(userId)?.connections.get(socket)
  if (!connection || connection.idle === idle) return
  connection.idle = idle
  changed(userId)
}

/** A call counts only once LiveKit lists the user in the room */
export async function presenceCall(socket: object, userId: string, roomName: string | null) {
  const before = people.get(userId)?.connections.get(socket)
  if (!before || before.call === roomName) return
  if (roomName !== null) {
    // One LiveKit lookup per connection every few seconds, however often a client asks
    const now = Date.now()
    if (now - before.checkedAt < CALL_CHECK_MS) return
    before.checkedAt = now
  }
  const joined = roomName !== null && (await inRoom(roomName, userId))
  const connection = people.get(userId)?.connections.get(socket)
  const call = joined ? roomName : null
  if (!connection || connection.call === call) return
  const left = connection.call
  connection.call = call
  changed(userId)
  for (const room of new Set([left, call])) if (room) void roomChanged(room)
}

/**
 * These users' calendars changed, so every client showing them asks again. Each user goes out alone after
 * their own random delay, so no message links the users who share an event
 */
export function calendarPresenceChanged(organizationId: string, userIds: Iterable<string>) {
  for (const userId of new Set(userIds)) {
    const key = `${organizationId}:${userId}`
    if (calendarPending.has(key)) continue
    calendarPending.add(key)
    const delay = CALENDAR_SETTLE_MS + randomInt(CALENDAR_JITTER_MS)
    setTimeout(() => {
      calendarPending.delete(key)
      sendToOrganization(organizationId, { type: "presence-calendar", userIds: [userId] })
    }, delay).unref()
  }
}
