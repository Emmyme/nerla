import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm"
import {
  calendarEvents,
  db,
  docCallAttendees,
  docCallShares,
  fileAttachments,
  fileFolders,
  projectMembers,
  projects,
  users,
  type Tx,
} from "../db"
import { capLevel, keptAfterCall, levelBelow, maxLevel, type DocLevel, type DocType } from "../utils/docAccess"
import { callGuestClaims, eventDay, meetingDocName, nearestOccurrence, type GuestDocClaims } from "../utils/docCalls"
import { DAY_MS, storedMs } from "../utils/eventTime"
import { logger } from "../utils/logger"
import { roomKind } from "../utils/meetingRooms"
import { presenceName } from "../utils/presence"
import { expandSeries } from "../utils/recurrence"
import { localDate } from "../utils/timeRules"
import { liveEvent, liveProject } from "../utils/trash"
import { eventRoomState } from "./calendarQueries"
import { armShareTimer, clearShareTimer, closeDocConnections, memberConnectionsThrough } from "./collab"
import { createDoc, docLevelFor, guestDocLevel, memberViewer, type LoadedDoc } from "./docs"
import type { FileViewer } from "./files"
import { inRoom, participantCount } from "./liveRooms"
import { membersOf } from "./tenancy"
import { personZone } from "./people"
import { errorText } from "../utils/errorText"

type ShareDto = {
  id: string
  fileId: string
  docType: DocType
  name: string
  level: DocLevel
  openedBy: { id: string; name: string }
}

type ShareRow = typeof docCallShares.$inferSelect

const MEETING_FOLDER: Record<DocType, string> = { paper: "Papers", board: "Boards" }

/** A guest's call pass, for a guest who is in its room right now */
export async function passGuest(token: string): Promise<{ identity: string; name: string; roomName: string } | null> {
  const claims = token ? callGuestClaims(token, new Date()) : null
  if (!claims || !(await inRoom(claims.roomName, claims.identity))) return null
  return claims
}

/** Open shares of docs that are not in Trash, oldest first */
async function shareDtos(where: ReturnType<typeof and>): Promise<ShareDto[]> {
  const rows = await db
    .select({
      id: docCallShares.id,
      fileId: docCallShares.fileId,
      level: docCallShares.level,
      docType: fileAttachments.docType,
      name: fileAttachments.fileName,
      openerId: docCallShares.openedBy,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(docCallShares)
    .innerJoin(fileAttachments, eq(fileAttachments.id, docCallShares.fileId))
    .innerJoin(users, eq(users.id, docCallShares.openedBy))
    // tenancy: every caller passes a condition that names the workspace or the share a guest proved
    .where(and(where, isNull(docCallShares.closedAt), isNull(fileAttachments.deletedAt), isNotNull(fileAttachments.docType)))
    .orderBy(asc(docCallShares.openedAt), asc(docCallShares.id))
  return rows.map((row) => ({
    id: row.id,
    fileId: row.fileId,
    docType: row.docType as DocType,
    name: row.name,
    level: row.level as DocLevel,
    openedBy: { id: row.openerId, name: presenceName(row.firstName, row.lastName) },
  }))
}

/** The open shares of a call. A member's workspace scopes them, a guest's verified room alone decides */
export function openSharesIn(roomName: string, organizationId: string | null): Promise<ShareDto[]> {
  return shareDtos(
    and(
      eq(docCallShares.roomName, roomName),
      organizationId ? eq(docCallShares.organizationId, organizationId) : undefined,
      eq(fileAttachments.organizationId, docCallShares.organizationId),
    ),
  )
}

async function shareDto(shareId: string, organizationId: string): Promise<ShareDto | null> {
  const [dto] = await shareDtos(and(eq(docCallShares.id, shareId), eq(docCallShares.organizationId, organizationId)))
  return dto ?? null
}

/** The user's "Papers" or "Boards" folder in My files, made the first time */
async function meetingFolder(v: FileViewer, docType: DocType): Promise<string> {
  const name = MEETING_FOLDER[docType]
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`meeting-folder:${v.organizationId}:${v.userId}:${name}`}, 0))`)
    const [found] = await tx
      .select({ id: fileFolders.id })
      .from(fileFolders)
      .where(
        and(
          eq(fileFolders.organizationId, v.organizationId),
          eq(fileFolders.createdBy, v.userId),
          eq(fileFolders.name, name),
          isNull(fileFolders.projectId),
          isNull(fileFolders.parentFolderId),
          isNull(fileFolders.deletedAt),
        ),
      )
      .limit(1)
    if (found) return found.id
    const now = new Date().toISOString()
    const [made] = await tx
      .insert(fileFolders)
      .values({ name, organizationId: v.organizationId, createdBy: v.userId, createdAt: now, updatedAt: now })
      .returning({ id: fileFolders.id })
    return made.id
  })
}

/**
 * The zone an event's days are counted in: its series zone, else its organizer's, else UTC. A meeting doc's day and
 * the event's Papers list both use it, so they agree wherever the users in the call are
 */
async function eventZone(masterId: string, organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ seriesZone: calendarEvents.recurrenceTz, organizerZone: users.timeZone })
    .from(calendarEvents)
    .innerJoin(users, eq(users.id, calendarEvents.createdBy))
    .where(and(eq(calendarEvents.id, masterId), eq(calendarEvents.organizationId, organizationId), liveEvent))
  return row?.seriesZone ?? row?.organizerZone ?? null
}

/**
 * The day of the call's occurrence, as the event's Papers list counts it: the occurrence going on now or the nearest
 * to now, and a one-off event's own day whenever its call happens
 */
async function occurrenceDay(masterId: string, organizationId: string, now: Date): Promise<string> {
  const zone = await eventZone(masterId, organizationId)
  const family = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.organizationId, organizationId),
        or(eq(calendarEvents.id, masterId), eq(calendarEvents.seriesId, masterId)),
        // trash: a cancelled occurrence in Trash still keeps its series from showing that day
        or(eq(calendarEvents.cancelled, true), liveEvent),
      ),
    )
  const master = family.find((row) => row.id === masterId)
  if (!master) return localDate(now, zone)
  const window = { from: new Date(now.getTime() - DAY_MS).toISOString(), to: new Date(now.getTime() + DAY_MS).toISOString() }
  const occurrences = master.recurrenceRule
    ? expandSeries(
        master,
        family.filter((row) => row.seriesId === masterId),
        window,
      )
    : [master]
  const start = storedMs(nearestOccurrence(occurrences, now)?.startsAt)
  if (start === null) return localDate(now, zone)
  const iso = new Date(start).toISOString()
  return eventDay(master.allDay ? { date: iso.slice(0, 10) } : { start: iso }, zone) ?? localDate(now, zone)
}

/** A new paper or board for the call, named after its event and day, linked to the event in a scheduled room */
async function meetingDoc(v: FileViewer, docType: DocType, roomName: string) {
  const room = roomKind(roomName)
  const eventId = room.kind === "scheduled" ? room.eventId : null
  const state = eventId ? await eventRoomState(eventId, v.organizationId) : null
  const event = state && state.masterId === eventId ? state : null
  const day = event ? await occurrenceDay(event.masterId, v.organizationId, new Date()) : localDate(new Date(), await personZone(v.userId))
  const folderId = await meetingFolder(v, docType)
  const fileId = await createDoc(v, docType, { projectId: null, folderId }, meetingDocName(event?.title ?? null, day))
  return { fileId, eventId: event?.masterId ?? null, occurrenceDate: event ? day : null }
}

type OpenShareInput = {
  roomName: string
  level: DocLevel
  fileId?: string
  create?: { docType: DocType; template: "blank" | "meeting" }
}

/**
 * Shows a doc in the caller's call at their own level at most, or makes a meeting doc for it. A doc already open in
 * the call keeps its share, raised when the caller asks for more and may give it. Null when the doc is out of reach
 */
export async function openShare(v: FileViewer, input: OpenShareInput): Promise<{ share: ShareDto; loaded: LoadedDoc } | null> {
  let fileId: string
  let level = input.level
  let meeting: { eventId: string | null; occurrenceDate: string | null } | null = null
  if (input.create) {
    const made = await meetingDoc(v, input.create.docType, input.roomName)
    fileId = made.fileId
    meeting = made
  } else {
    const own = await docLevelFor(input.fileId!, v)
    if (!own.file || !own.level || own.file.deletedAt) return null
    fileId = own.file.id
    level = capLevel(level, own.level)
    // A doc made for this meeting is still the meeting's when it is shown again
    const [earlier] = await db
      .select({ id: docCallShares.id })
      .from(docCallShares)
      .where(
        and(
          eq(docCallShares.organizationId, v.organizationId),
          eq(docCallShares.fileId, fileId),
          eq(docCallShares.roomName, input.roomName),
          eq(docCallShares.forMeeting, true),
        ),
      )
      .limit(1)
    if (earlier) meeting = { eventId: null, occurrenceDate: null }
  }
  const opened = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`doc-call-share:${v.organizationId}:${input.roomName}:${fileId}`}, 0))`,
    )
    const [open] = await tx
      .select({ id: docCallShares.id, level: docCallShares.level })
      .from(docCallShares)
      .where(
        and(
          eq(docCallShares.organizationId, v.organizationId),
          eq(docCallShares.roomName, input.roomName),
          eq(docCallShares.fileId, fileId),
          isNull(docCallShares.closedAt),
        ),
      )
      .limit(1)
    if (open && levelBelow(open.level as DocLevel, level)) {
      await tx
        .update(docCallShares)
        .set({ level })
        .where(and(eq(docCallShares.id, open.id), eq(docCallShares.organizationId, v.organizationId)))
      return { id: open.id, fresh: false, raised: true }
    }
    if (open) return { id: open.id, fresh: false, raised: false }
    const [made] = await tx
      .insert(docCallShares)
      .values({
        organizationId: v.organizationId,
        fileId,
        roomName: input.roomName,
        openedBy: v.userId,
        level,
        forMeeting: !!meeting,
        eventId: meeting?.eventId ?? null,
        occurrenceDate: meeting?.occurrenceDate ?? null,
      })
      .returning({ id: docCallShares.id })
    return { id: made.id, fresh: true, raised: false }
  })
  // Nobody is connected through a new share yet, so it closes unless a user opens it soon
  if (opened.fresh) armShareTimer(opened.id, v.organizationId)
  // A connection's level is set as it signs in, so everyone through the share signs in again at the new one
  if (opened.raised) closeDocConnections({ shareId: opened.id })
  const shareId = opened.id
  const [share, after] = await Promise.all([shareDto(shareId, v.organizationId), docLevelFor(fileId, v)])
  return share && after.loaded ? { share, loaded: after.loaded } : null
}

/** Whether the share is still open */
export async function shareIsOpen(shareId: string, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: docCallShares.id })
    .from(docCallShares)
    .where(and(eq(docCallShares.id, shareId), eq(docCallShares.organizationId, organizationId), isNull(docCallShares.closedAt)))
    .limit(1)
  return !!row
}

/** Closes the open shares of calls everyone has left, as a normal close. A room LiveKit can't answer for is skipped */
export async function closeEmptyRoomShares(): Promise<void> {
  // tenancy: every workspace on purpose, for the live server's sweep
  const open = await db
    .select({ id: docCallShares.id, organizationId: docCallShares.organizationId, roomName: docCallShares.roomName })
    .from(docCallShares)
    .where(isNull(docCallShares.closedAt))
  const rooms = [...new Set(open.map((share) => share.roomName))]
  const counts = new Map(await Promise.all(rooms.map(async (roomName) => [roomName, await participantCount(roomName)] as const)))
  for (const share of open) {
    if (counts.get(share.roomName) === 0) await closeShare(share.id, share.organizationId)
  }
}

/** An open share in the workspace */
export async function findOpenShare(shareId: string, organizationId: string): Promise<(ShareRow & { ownerId: string }) | null> {
  const [row] = await db
    .select({ share: docCallShares, ownerId: fileAttachments.uploadedBy })
    .from(docCallShares)
    .innerJoin(fileAttachments, eq(fileAttachments.id, docCallShares.fileId))
    .where(and(eq(docCallShares.id, shareId), eq(docCallShares.organizationId, organizationId), isNull(docCallShares.closedAt)))
  return row ? { ...row.share, ownerId: row.ownerId } : null
}

/** An open share for a guest, by the id they asked for. Its doc must not be in Trash */
export async function openShareForGuest(shareId: string): Promise<ShareRow | null> {
  // tenancy: a guest has no workspace, their verified room is checked against this share's
  const [row] = await db
    .select({ share: docCallShares })
    .from(docCallShares)
    .innerJoin(fileAttachments, eq(fileAttachments.id, docCallShares.fileId))
    .where(and(eq(docCallShares.id, shareId), isNull(docCallShares.closedAt), isNull(fileAttachments.deletedAt)))
  return row?.share ?? null
}

/** Records a member who connected through the share. Once per user and share */
export async function recordAttendance(shareId: string, userId: string, organizationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`doc-call-attendee:${shareId}:${userId}`}, 0))`)
    const [seen] = await tx
      .select({ id: docCallAttendees.id })
      .from(docCallAttendees)
      .where(
        and(
          eq(docCallAttendees.shareId, shareId),
          eq(docCallAttendees.userId, userId),
          eq(docCallAttendees.organizationId, organizationId),
        ),
      )
      .limit(1)
    if (!seen) await tx.insert(docCallAttendees).values({ organizationId, shareId, userId })
  })
}

/** Writes what each attendee keeps once the share closes, as file grants that never lower a grant they have */
async function writeLastingGrants(tx: Tx, share: ShareRow): Promise<void> {
  const { organizationId } = share
  const [file] = await tx
    .select({ id: fileAttachments.id, ownerId: fileAttachments.uploadedBy, projectId: fileAttachments.projectId })
    .from(fileAttachments)
    .where(and(eq(fileAttachments.id, share.fileId), eq(fileAttachments.organizationId, organizationId)))
  if (!file) return
  const attendees = await tx
    .select({ userId: docCallAttendees.userId })
    .from(docCallAttendees)
    .where(and(eq(docCallAttendees.shareId, share.id), eq(docCallAttendees.organizationId, organizationId)))
  const members = await membersOf(
    organizationId,
    attendees.map((row) => row.userId).filter((id) => id !== file.ownerId),
    tx,
  )
  if (members.size === 0) return
  const inProject = file.projectId
    ? new Set(
        (
          await tx
            .select({ userId: projectMembers.userId })
            .from(projectMembers)
            .innerJoin(projects, eq(projects.id, projectMembers.projectId))
            .where(
              and(
                eq(projectMembers.projectId, file.projectId),
                eq(projects.organizationId, organizationId),
                inArray(projectMembers.userId, [...members]),
                liveProject,
              ),
            )
        ).map((row) => row.userId),
      )
    : new Set<string>()
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`file-grant:file:${file.id}`}, 0))`)
  const facts = {
    forMeeting: share.forMeeting,
    level: share.level as DocLevel,
    openedByOwner: share.openedBy === file.ownerId,
    projectId: file.projectId,
  }
  for (const userId of members) {
    const kept = keptAfterCall(facts, { isProjectMember: inProject.has(userId) })
    if (!kept) continue
    const { level: current } = await docLevelFor(file.id, { userId, organizationId, isOrgAdmin: false }, tx)
    if (current && !levelBelow(current, kept)) continue
    const match = sql`g.file_id = ${file.id}::uuid and g.user_id = ${userId}::uuid and g.organization_id = ${organizationId}::uuid`
    const existing = await tx.execute<{ level: string }>(sql`select g.level from file_grants g where ${match}`)
    if (existing.length > 0) {
      const best = existing.reduce<DocLevel | null>((top, row) => maxLevel(top, row.level as DocLevel), null)
      if (best !== maxLevel(best, kept)) await tx.execute(sql`update file_grants g set level = ${kept} where ${match}`)
      continue
    }
    await tx.execute(sql`
      insert into file_grants (file_id, user_id, granted_by, level, organization_id)
      values (${file.id}::uuid, ${userId}::uuid, ${share.openedBy}::uuid, ${kept}, ${organizationId}::uuid)`)
  }
}

/** Closes members' connections through the share whose level drops now that it is closed */
async function closeDroppedMembers(share: ShareRow): Promise<void> {
  const connections = memberConnectionsThrough(share.id)
  const levels = new Map<string, DocLevel | null>()
  for (const userId of new Set(connections.map((connection) => connection.userId))) {
    levels.set(userId, (await docLevelFor(share.fileId, await memberViewer(userId, share.organizationId))).level)
  }
  for (const connection of connections) {
    const now = levels.get(connection.userId) ?? null
    if (!now || levelBelow(now, connection.level)) connection.close()
  }
}

/**
 * Closes an open share. Attendees keep what `keptAfterCall` gives them unless the doc went to Trash, guests are
 * disconnected, and members whose level drops reconnect at the new one. False when it was already closed
 */
export async function closeShare(shareId: string, organizationId: string, { lasting = true } = {}): Promise<boolean> {
  clearShareTimer(shareId)
  const closed = await db.transaction(async (tx) => {
    const [share] = await tx
      .update(docCallShares)
      .set({ closedAt: new Date().toISOString() })
      .where(and(eq(docCallShares.id, shareId), eq(docCallShares.organizationId, organizationId), isNull(docCallShares.closedAt)))
      .returning()
    if (share && lasting) await writeLastingGrants(tx, share)
    return share ?? null
  })
  if (!closed) return false
  closeDocConnections({ shareId, guestsOnly: true })
  await closeDroppedMembers(closed)
  return true
}

/**
 * Closes the timer's share once nobody has been connected through it for a while and its call is empty. The panel
 * shows one doc at a time, so in a call with users a share stays open until it is stopped or the call ends
 */
export function closeIdleShare(shareId: string, organizationId: string): void {
  ;(async () => {
    const [share] = await db
      .select({ roomName: docCallShares.roomName })
      .from(docCallShares)
      .where(and(eq(docCallShares.id, shareId), eq(docCallShares.organizationId, organizationId), isNull(docCallShares.closedAt)))
    if (share && (await participantCount(share.roomName)) === 0) await closeShare(shareId, organizationId)
  })().catch((error) => logger.warn("Closing an idle call share failed", { error: errorText(error) }))
}

/** Docs going to Trash leave every call, with no lasting grants. Their connections were already closed */
export async function closeTrashedShares(fileIds: string[], organizationId: string): Promise<void> {
  if (fileIds.length === 0) return
  const closed = await db
    .update(docCallShares)
    .set({ closedAt: new Date().toISOString() })
    .where(and(inArray(docCallShares.fileId, fileIds), eq(docCallShares.organizationId, organizationId), isNull(docCallShares.closedAt)))
    .returning({ id: docCallShares.id })
  for (const share of closed) clearShareTimer(share.id)
}

/** Every open share gets its idle timer again after a restart, since the timers live in memory */
export async function resumeShareTimers(): Promise<void> {
  // tenancy: every workspace on purpose, at start up
  const open = await db
    .select({ id: docCallShares.id, organizationId: docCallShares.organizationId })
    .from(docCallShares)
    .where(isNull(docCallShares.closedAt))
  for (const share of open) armShareTimer(share.id, share.organizationId)
}

/** The docs made in a meeting on that day that the caller can open. `start` is the occurrence's start, read in the event's zone */
export async function docsForEvent(v: FileViewer, eventId: string, when: { date?: string; start?: string }): Promise<LoadedDoc[]> {
  const state = await eventRoomState(eventId, v.organizationId)
  if (!state) return []
  const date = eventDay(when, when.start ? await eventZone(state.masterId, v.organizationId) : null)
  if (!date) return []
  const rows = await db
    .selectDistinct({ fileId: docCallShares.fileId })
    .from(docCallShares)
    .where(
      and(
        eq(docCallShares.organizationId, v.organizationId),
        eq(docCallShares.eventId, state.masterId),
        eq(docCallShares.occurrenceDate, date),
      ),
    )
  const found = await Promise.all(rows.map((row) => docLevelFor(row.fileId, v)))
  return found
    .filter((doc) => doc.level && doc.loaded && !doc.loaded.file.deletedAt)
    .map((doc) => doc.loaded!)
    .sort((a, b) => a.file.createdAt.localeCompare(b.file.createdAt))
}

/** A paper's image for a guest whose doc token reaches that paper */
export async function guestDocImage(fileId: string, claims: GuestDocClaims): Promise<typeof fileAttachments.$inferSelect | null> {
  const access = await guestDocLevel(claims)
  if (!access) return null
  const [image] = await db
    .select()
    .from(fileAttachments)
    .where(
      and(
        eq(fileAttachments.id, fileId),
        eq(fileAttachments.organizationId, access.organizationId),
        eq(fileAttachments.kind, "docimage"),
        eq(fileAttachments.docFileId, access.file.id),
      ),
    )
  return image ?? null
}
