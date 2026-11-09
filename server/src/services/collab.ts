import { Database } from "@hocuspocus/extension-database"
import { Hocuspocus, type Connection, type Document, type WebSocketLike, type onAuthenticatePayload } from "@hocuspocus/server"
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import * as Y from "yjs"
import { db, docContents, docMentions, docVersions, fileAttachments } from "../db"
import type { Via } from "../utils/aiTypes"
import { COOKIE_NAME, cookieOriginAllowed } from "../utils/authCookie"
import { serverInstant } from "../utils/chatAccess"
import { canSeeComments, docPath, levelBelow, type DocLevel } from "../utils/docAccess"
import { guestDocClaims } from "../utils/docCalls"
import { mentionsToCheck, mentionsToRecord } from "../utils/docMentions"
import { mentionIdsIn, restoreInto } from "../utils/docYjs"
import { logger } from "../utils/logger"
import { isRefusal } from "../utils/tenancy"
import { closeEmptyRoomShares, closeIdleShare, recordAttendance, shareIsOpen } from "./docCalls"
import { docLevelFor, docState, guestDocLevel, memberViewer, reachableLevel } from "./docs"
import { notify } from "./notifications"
import { verifyAuthToken } from "./sessions"
import { membersOf, resolveOrg } from "./tenancy"
import { UUID } from "../utils/uuid"
import { errorText } from "../utils/errorText"

export type DocContext = {
  organizationId: string
  userId: string | null
  guest: { identity: string; name: string } | null
  level: DocLevel
  shareId: string | null
  /** The member JWT it signed in with, checked again while it stays open */
  sessionToken: string | null
}

export const KEPT_VERSIONS = 200
/** Far above any real paper or board. One past it is kept but takes no more edits */
const DOC_MAX_BYTES = 32 * 1024 * 1024
const TOO_LARGE = JSON.stringify({ type: "too-large" })

/** Every connection to a doc that grew past the limit turns read-only and hears why */
function stopEditing(document: Y.Doc & { getConnections(): { readOnly: boolean; sendStateless(message: string): void }[] }) {
  for (const connection of document.getConnections()) {
    if (connection.readOnly) continue
    connection.readOnly = true
    connection.sendStateless(TOO_LARGE)
  }
}
/** Sockets outlive their token, so open connections check their session again this often, as the main socket does */
const RECHECK_MS = 60_000
const DEFAULT_VERSION_WINDOW_MS = 5 * 60 * 1000
/** A call share closes once nobody has been connected through it for this long */
const SHARE_IDLE_MS = 2 * 60 * 1000

/** How old the newest version must be before a store takes another. Shortened only for live checks */
function versionWindowMs(): number {
  const set = process.env.DOC_VERSION_WINDOW_MS
  const ms = Number(set)
  return set && Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_VERSION_WINDOW_MS
}

const FORBIDDEN = { code: 4403, reason: "Forbidden" }

/** The file a live document name points at. Only `doc:{fileId}` names exist */
function fileIdOf(documentName: string): string | null {
  const id = documentName.startsWith("doc:") ? documentName.slice(4) : ""
  // Only the lowercase name is the doc everyone else edits and the one access changes close
  return UUID.test(id) && id === id.toLowerCase() ? id : null
}

/** Each loaded doc's workspace, set as it loads */
const workspaceOf = new WeakMap<Y.Doc, string>()
/** The socket behind each upgrade, so a refusal can close it */
const socketOf = new WeakMap<Request, WebSocketLike>()
/** The host each upgrade was sent to, as Fastify reads it behind a trusted proxy */
const hostOf = new WeakMap<Request, string>()
/** Who changed each doc since its newest version. A doc with an entry has changes no version holds yet */
const editorsSince = new Map<string, Set<string>>()
/** Each loaded doc's mentions: who is handled, so a store only looks up new ones, and who still waits for access */
const mentionStates = new Map<string, { known: Set<string>; waiting: Set<string>; checkedAt: number }>()
/** Stores still running, so a shutdown can wait for them */
const pending = new Set<Promise<unknown>>()
/** The idle timer of each open call share that nobody is connected through */
const shareTimers = new Map<string, NodeJS.Timeout>()

let app: FastifyInstance | null = null
let instance: Hocuspocus<DocContext> | null = null
let recheckTimer: NodeJS.Timeout | null = null

function tracked<T>(work: Promise<T>): Promise<T> {
  pending.add(work)
  return work.finally(() => pending.delete(work))
}

function markChanged(documentName: string, userIds: Iterable<string>) {
  editorsSince.set(documentName, new Set([...(editorsSince.get(documentName) ?? []), ...userIds]))
}

/** The member session and its token, and whether the cookie is what signed it in */
async function memberSession(headers: Headers, token: string) {
  if (!app) return null
  const cookie = headers.get("cookie")
  const fromCookie = cookie ? app.parseCookie(cookie)[COOKIE_NAME] : undefined
  if (fromCookie) {
    const session = await verifyAuthToken(app, fromCookie)
    if (session) return { session, token: fromCookie, viaCookie: true }
  }
  const session = token ? await verifyAuthToken(app, token) : null
  return session ? { session, token, viaCookie: false } : null
}

/** A guest's doc token as the provider token, while its share is open and the guest is in the call */
async function authenticateGuest(payload: onAuthenticatePayload<DocContext>, fileId: string): Promise<DocContext> {
  const claims = payload.token ? guestDocClaims(payload.token, new Date()) : null
  if (!claims || claims.fileId !== fileId) throw FORBIDDEN
  const access = await guestDocLevel(claims)
  if (!access) throw FORBIDDEN
  payload.connectionConfig.readOnly = access.level !== "edit" || access.file.fileSize > DOC_MAX_BYTES
  return {
    organizationId: access.organizationId,
    userId: null,
    guest: { identity: claims.identity, name: claims.name },
    level: access.level,
    shareId: claims.shareId,
    sessionToken: null,
  }
}

/** The cookie on the upgrade, else the provider token as a member JWT, else as a guest doc token */
async function authenticate(payload: onAuthenticatePayload<DocContext>): Promise<DocContext> {
  const fileId = fileIdOf(payload.documentName)
  if (!fileId) throw FORBIDDEN
  const signedIn = await memberSession(payload.requestHeaders, payload.token)
  if (!signedIn) return authenticateGuest(payload, fileId)
  // Another site's page would send the cookie too, so the cookie counts only from Nerla's own pages
  if (signedIn.viaCookie && !cookieOriginAllowed(payload.requestHeaders.get("origin"), hostOf.get(payload.request))) {
    // Closed once the refusal is sent, so the client hears why
    const socket = socketOf.get(payload.request)
    setTimeout(() => socket?.close(FORBIDDEN.code, FORBIDDEN.reason), 0)
    throw FORBIDDEN
  }
  const { session } = signedIn
  const org = await resolveOrg(session.id)
  if (isRefusal(org)) throw FORBIDDEN
  const shareParam = payload.requestParameters.get("shareId")?.toLowerCase()
  const shareId = shareParam && UUID.test(shareParam) ? shareParam : null
  const viewer = { userId: session.id, organizationId: org.organizationId, isOrgAdmin: org.role === "admin" }
  const { file, level, callLevel } = await docLevelFor(fileId, viewer, db, shareId ? { shareId } : {})
  if (!file || !level) throw FORBIDDEN
  // Connecting through an open share is what attending it means
  if (shareId && callLevel) await recordAttendance(shareId, session.id, org.organizationId)
  payload.connectionConfig.readOnly = level !== "edit" || file.fileSize > DOC_MAX_BYTES
  return {
    organizationId: org.organizationId,
    userId: session.id,
    guest: null,
    level,
    shareId: callLevel ? shareId : null,
    sessionToken: signedIn.token,
  }
}

/** Whether anyone, member or guest, is connected through the share */
function connectedThrough(shareId: string): boolean {
  if (!instance) return false
  for (const document of instance.documents.values()) {
    if (document.getConnections().some((connection) => connection.context.shareId === shareId)) return true
  }
  return false
}

/** Starts the share's idle timer unless it runs already */
export function armShareTimer(shareId: string, organizationId: string): void {
  if (shareTimers.has(shareId)) return
  const timer = setTimeout(() => {
    shareTimers.delete(shareId)
    if (!connectedThrough(shareId)) closeIdleShare(shareId, organizationId)
  }, SHARE_IDLE_MS)
  timer.unref()
  shareTimers.set(shareId, timer)
}

export function clearShareTimer(shareId: string): void {
  clearTimeout(shareTimers.get(shareId))
  shareTimers.delete(shareId)
}

/** Saves the doc's state as a version when something changed since the last one, or always when `force` is set */
async function saveVersion(documentName: string, document: Y.Doc, force = false, via: Via | null = null): Promise<boolean> {
  const fileId = fileIdOf(documentName)
  const organizationId = workspaceOf.get(document)
  if (!fileId || !organizationId) return false
  const editors = editorsSince.get(documentName)
  if (!editors && !force) return false
  editorsSince.delete(documentName)
  try {
    await db.transaction(async (tx) => {
      await tx.insert(docVersions).values({
        organizationId,
        fileId,
        state: Buffer.from(Y.encodeStateAsUpdate(document)),
        editorIds: [...(editors ?? [])],
        via,
      })
      const kept = tx
        .select({ id: docVersions.id })
        .from(docVersions)
        .where(and(eq(docVersions.fileId, fileId), eq(docVersions.organizationId, organizationId)))
        .orderBy(desc(docVersions.createdAt), desc(docVersions.id))
        .limit(KEPT_VERSIONS)
      await tx
        .delete(docVersions)
        .where(and(eq(docVersions.fileId, fileId), eq(docVersions.organizationId, organizationId), notInArray(docVersions.id, kept)))
    })
    return true
  } catch (error) {
    // The changes stay pending, so the next store or disconnect tries again
    if (editors) markChanged(documentName, editors)
    throw error
  }
}

/** True when the newest version, or the doc itself when it has none, is older than the window */
async function versionDue(fileId: string, organizationId: string, createdAt: string): Promise<boolean> {
  const [newest] = await db
    .select({ createdAt: docVersions.createdAt })
    .from(docVersions)
    .where(and(eq(docVersions.fileId, fileId), eq(docVersions.organizationId, organizationId)))
    .orderBy(desc(docVersions.createdAt))
    .limit(1)
  return Date.now() - serverInstant(newest?.createdAt ?? createdAt) >= versionWindowMs()
}

/**
 * Records users newly mentioned in the text who can open the doc now, a call share included, and notifies them. A user
 * who cannot yet is checked again at most once a minute, so they hear of it once they get access. A store no member
 * made records nothing and leaves the mentions to the next one a member makes
 */
async function recordMentions(documentName: string, document: Y.Doc, actorId: string | null) {
  const fileId = fileIdOf(documentName)
  const organizationId = workspaceOf.get(document)
  if (!fileId || !organizationId) return
  const state = mentionStates.get(documentName) ?? { known: new Set<string>(), waiting: new Set<string>(), checkedAt: 0 }
  mentionStates.set(documentName, state)
  const now = Date.now()
  const unseen = mentionsToCheck(mentionIdsIn(document), state, actorId, now)
  if (unseen.length === 0) return
  const members = await membersOf(organizationId, unseen)
  const canOpen = new Set<string>()
  for (const userId of members) {
    if ((await reachableLevel(fileId, await memberViewer(userId, organizationId))).level) canOpen.add(userId)
  }
  const { record, settled } = await db.transaction(async (tx) => {
    // One store of a doc at a time records its mentions, so nobody is recorded twice
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`doc-mentions:${fileId}`}, 0))`)
    const recorded = await tx
      .select({ userId: docMentions.userId })
      .from(docMentions)
      .where(and(eq(docMentions.fileId, fileId), eq(docMentions.organizationId, organizationId), inArray(docMentions.userId, unseen)))
    const found = mentionsToRecord(unseen, new Set(recorded.map((row) => row.userId)), canOpen)
    if (found.record.length > 0) {
      await tx.insert(docMentions).values(found.record.map((userId) => ({ organizationId, fileId, userId })))
    }
    return found
  })
  const done = new Set(settled)
  for (const id of unseen) {
    if (done.has(id)) {
      state.known.add(id)
      state.waiting.delete(id)
    } else state.waiting.add(id)
  }
  state.checkedAt = now
  if (record.length > 0 && actorId) void notify(organizationId, { type: "doc_mention", actorId, fileId, userIds: record })
}

/** Never refuses a store, so no edit is lost, and a doc past DOC_MAX_BYTES stops taking edits. A doc whose row is gone is skipped */
async function store(documentName: string, state: Buffer, document: Y.Doc, actorId: string | null) {
  const fileId = fileIdOf(documentName)
  const organizationId = workspaceOf.get(document)
  if (!fileId || !organizationId) return
  const now = new Date().toISOString()
  const saved = await db.transaction(async (tx) => {
    const [file] = await tx
      .select({ createdAt: fileAttachments.createdAt })
      .from(fileAttachments)
      .where(and(eq(fileAttachments.id, fileId), eq(fileAttachments.organizationId, organizationId)))
      .for("update")
    if (!file) return null
    const [stored] = await tx
      .select({ state: docContents.state })
      .from(docContents)
      .where(and(eq(docContents.fileId, fileId), eq(docContents.organizationId, organizationId)))
      .for("update")
    // Another server may have stored edits this copy never saw, and merging full states keeps both
    const merged = stored ? Buffer.from(Y.mergeUpdates([stored.state, state])) : state
    await tx
      .update(fileAttachments)
      .set({ fileSize: merged.length, updatedAt: now })
      .where(and(eq(fileAttachments.id, fileId), eq(fileAttachments.organizationId, organizationId)))
    await tx
      .insert(docContents)
      .values({ fileId, organizationId, state: merged, updatedAt: now })
      .onConflictDoUpdate({
        target: docContents.fileId,
        set: { state: merged, updatedAt: now },
        setWhere: eq(docContents.organizationId, organizationId),
      })
    return { createdAt: file.createdAt, size: merged.length }
  })
  if (!saved) return
  if (saved.size > DOC_MAX_BYTES) stopEditing(document as Parameters<typeof stopEditing>[0])
  // The state is stored, so a version or mention that fails is only tried again later and never fails the store
  try {
    if (editorsSince.has(documentName) && (await versionDue(fileId, organizationId, saved.createdAt))) {
      await saveVersion(documentName, document)
    }
  } catch (error) {
    logger.warn("Saving a version on store failed", { error: errorText(error) })
  }
  try {
    await recordMentions(documentName, document, actorId)
  } catch (error) {
    logger.warn("Recording mentions failed", { error: errorText(error) })
  }
}

function build(): Hocuspocus<DocContext> {
  return new Hocuspocus<DocContext>({
    quiet: true,
    extensions: [
      new Database({
        fetch: async ({ documentName, document, context }) => {
          const fileId = fileIdOf(documentName)
          if (!fileId || !context?.organizationId) throw FORBIDDEN
          workspaceOf.set(document, context.organizationId)
          const state = await docState(fileId, context.organizationId)
          return state ? new Uint8Array(state) : null
        },
        store: ({ documentName, state, document, lastContext }) =>
          tracked(store(documentName, state, document, lastContext?.userId ?? null)),
      }),
    ],
    onAuthenticate: authenticate,
    async connected({ context, connection }) {
      if (!context.shareId) return
      clearShareTimer(context.shareId)
      // A share that closed while this connection was still signing in gives it nothing, so it signs in again
      let open = false
      try {
        open = await shareIsOpen(context.shareId, context.organizationId)
      } catch (error) {
        logger.warn("Checking a call share on connect failed", { error: errorText(error) })
      }
      if (!open) closeConnection(connection)
    },
    async onChange({ documentName, context }) {
      markChanged(documentName, context?.userId ? [context.userId] : [])
    },
    async onDisconnect({ documentName, document, clientsCount, context }) {
      const shareId = context?.shareId
      if (shareId && !document.getConnections().some((connection) => connection.context.shareId === shareId)) {
        armShareTimer(shareId, context.organizationId)
      }
      if (clientsCount > 0) return
      try {
        await tracked(saveVersion(documentName, document))
      } catch (error) {
        logger.warn("Saving a version on the last disconnect failed", { error: errorText(error) })
      }
    },
    async afterUnloadDocument({ documentName }) {
      mentionStates.delete(documentName)
    },
  })
}

/** The live server, made on first use */
export function collab(): Hocuspocus<DocContext> {
  instance ??= build()
  return instance
}

/** Closes guests whose share closed or who left the call since they connected */
async function recheckGuests(byGuest: Map<string, Connection<DocContext>[]>) {
  for (const connections of byGuest.values()) {
    const { context, document } = connections[0]
    const claims = {
      shareId: context.shareId!,
      fileId: fileIdOf(document.name)!,
      identity: context.guest!.identity,
      name: context.guest!.name,
    }
    try {
      if (await guestDocLevel(claims)) continue
    } catch (error) {
      logger.warn("Checking a live doc guest failed", { error: errorText(error) })
      continue
    }
    for (const connection of connections) closeConnection(connection)
  }
}

/**
 * Closes members whose level has dropped since they connected, through their own access or the share they came by.
 * They reconnect at the level they have now, or are refused
 */
async function recheckMembers(byMember: Map<string, Connection<DocContext>[]>) {
  for (const connections of byMember.values()) {
    const { context, document } = connections[0]
    const fileId = fileIdOf(document.name)
    if (!fileId || !context.userId) continue
    let level: DocLevel | null
    try {
      const viewer = await memberViewer(context.userId, context.organizationId)
      level = (await docLevelFor(fileId, viewer, db, context.shareId ? { shareId: context.shareId } : {})).level
    } catch (error) {
      logger.warn("Checking a live doc member failed", { error: errorText(error) })
      continue
    }
    for (const connection of connections) {
      if (!level || levelBelow(level, connection.context.level)) closeConnection(connection)
    }
  }
}

/** The member connections that match, grouped by doc, share and user, so each is checked once */
function memberGroups(match: { fileIds?: string[]; userId?: string } = {}): Map<string, Connection<DocContext>[]> {
  const groups = new Map<string, Connection<DocContext>[]>()
  if (!instance) return groups
  const names = match.fileIds ? new Set(match.fileIds.map(docPath)) : null
  for (const document of instance.documents.values()) {
    if (names && !names.has(document.name)) continue
    for (const connection of document.getConnections()) {
      const { userId, shareId } = connection.context
      if (!userId || (match.userId && userId !== match.userId)) continue
      const key = [document.name, shareId ?? "", userId].join("|")
      groups.set(key, [...(groups.get(key) ?? []), connection])
    }
  }
  return groups
}

/**
 * Checks the live member connections on those docs, or of that user, again and closes those whose level dropped.
 * For a path to a doc that went away, such as a deleted post or a chat a user left
 */
export async function recheckDocConnections(match: { fileIds?: string[]; userId?: string }): Promise<void> {
  if (match.fileIds?.length === 0) return
  await recheckMembers(memberGroups(match))
}

let sweeping = false

/**
 * Closes guests who are done, members whose session ended since they connected, such as by signing out, members
 * whose level dropped, and then the shares of calls everyone has left. A sweep that runs long is never overlapped
 */
async function recheckSessions() {
  if (!instance || !app || sweeping) return
  sweeping = true
  try {
    const byToken = new Map<string, Connection<DocContext>[]>()
    const byGuest = new Map<string, Connection<DocContext>[]>()
    for (const document of instance.documents.values()) {
      for (const connection of document.getConnections()) {
        const { sessionToken: token, guest, shareId } = connection.context
        if (token) byToken.set(token, [...(byToken.get(token) ?? []), connection])
        const key = guest && shareId ? [document.name, shareId, guest.identity].join("|") : null
        if (key) byGuest.set(key, [...(byGuest.get(key) ?? []), connection])
      }
    }
    await recheckGuests(byGuest)
    await recheckMembers(memberGroups())
    for (const [token, connections] of byToken) {
      try {
        if (await verifyAuthToken(app, token)) continue
      } catch (error) {
        logger.warn("Checking a live doc session failed", { error: errorText(error) })
        continue
      }
      for (const connection of connections) closeConnection(connection)
    }
    try {
      await closeEmptyRoomShares()
    } catch (error) {
      logger.warn("Closing the shares of empty calls failed", { error: errorText(error) })
    }
  } finally {
    sweeping = false
  }
}

/** Gives the live server what it needs to check member sessions */
export function attachCollab(fastify: FastifyInstance): Hocuspocus<DocContext> {
  app = fastify
  if (!recheckTimer) {
    recheckTimer = setInterval(() => void recheckSessions(), RECHECK_MS)
    recheckTimer.unref()
  }
  return collab()
}

type CollabSocket = {
  handleMessage(data: Uint8Array): void
  handleClose(event?: { code: number; reason: string }): void
  touch(): void
}

/** Hands an upgraded socket to the live server */
export function openCollabSocket(socket: WebSocketLike, request: Request, host: string): CollabSocket {
  socketOf.set(request, socket)
  hostOf.set(request, host)
  return collab().handleConnection(socket, request)
}

/** Stores every open doc and waits for the stores, for a shutdown */
export async function closeCollab(): Promise<void> {
  if (recheckTimer) clearInterval(recheckTimer)
  recheckTimer = null
  for (const shareId of [...shareTimers.keys()]) clearShareTimer(shareId)
  if (!instance) return
  instance.flushPendingStores()
  // A flushed store starts a few ticks later, and one waiting on its doc's lock starts once the one before ends
  for (;;) {
    await new Promise((resolve) => setImmediate(resolve))
    if (pending.size === 0) break
    await Promise.allSettled([...pending])
  }
  await Promise.allSettled([...instance.documents].map(([name, document]) => saveVersion(name, document)))
}

type ConnectionMatch = { fileId?: string; userId?: string; shareId?: string; guestsOnly?: boolean }

function closeConnection(connection: Connection<DocContext>) {
  connection.close(FORBIDDEN)
  // The provider authenticates again only on a new socket
  connection.webSocket.close(FORBIDDEN.code, FORBIDDEN.reason)
}

/**
 * Closes the sockets of the live connections that match, so the client reconnects and authentication decides again.
 * Returns how many connections it closed
 */
export function closeDocConnections(match: ConnectionMatch): number {
  if (!instance) return 0
  let closed = 0
  const one = match.fileId ? instance.documents.get(docPath(match.fileId)) : undefined
  const documents = match.fileId ? (one ? [one] : []) : [...instance.documents.values()]
  for (const document of documents) {
    for (const connection of document.getConnections()) {
      const context = connection.context
      if (match.userId && context.userId !== match.userId) continue
      if (match.shareId && context.shareId !== match.shareId) continue
      if (match.guestsOnly && !context.guest) continue
      closeConnection(connection)
      closed += 1
    }
  }
  return closed
}

/** Members connected through a share, with the level each opened at */
export function memberConnectionsThrough(shareId: string): { userId: string; level: DocLevel; close: () => void }[] {
  if (!instance) return []
  const found: { userId: string; level: DocLevel; close: () => void }[] = []
  for (const document of instance.documents.values()) {
    for (const connection of document.getConnections()) {
      const { userId, level } = connection.context
      if (connection.context.shareId === shareId && userId) found.push({ userId, level, close: () => closeConnection(connection) })
    }
  }
  return found
}

/** Sends a stateless message to the doc's connections that may see comments. Viewers never hear it */
function tellCommenters(fileId: string, message: object): void {
  const document = instance?.documents.get(docPath(fileId))
  if (!document) return
  const text = JSON.stringify(message)
  for (const connection of document.getConnections()) {
    if (canSeeComments(connection.context.level)) connection.sendStateless(text)
  }
}

/** Tells the connections that may see comments that they changed */
export function notifyComments(fileId: string): void {
  tellCommenters(fileId, { type: "comments" })
}

/** Tells the connections that may see comments that the AI is working on a reply in a thread, or no longer is */
export function notifyAiWorking(fileId: string, commentId: string, name: string, working: boolean): void {
  tellCommenters(fileId, { type: "ai-working", commentId, name, working })
}

/** Who changed the doc since its newest version, or null when nothing did */
export function unsavedEditors(fileId: string): string[] | null {
  const editors = editorsSince.get(docPath(fileId))
  return editors ? [...editors] : null
}

/**
 * Saves the live doc as a version now, as a restore does first. With `via` the version is an edit by the user's
 * agent or AI, and lists them as its editor
 */
export async function saveVersionNow(fileId: string, context: DocContext, via: Via | null): Promise<void> {
  const documentName = docPath(fileId)
  if (via && context.userId) markChanged(documentName, [context.userId])
  const connection = await collab().openDirectConnection(documentName, context)
  try {
    await saveVersion(documentName, connection.document as Document, true, via)
  } finally {
    await connection.disconnect()
  }
}

/** Puts an old version back for everyone connected, after saving the current state as a version */
export async function restoreVersion(fileId: string, context: DocContext, old: Buffer): Promise<void> {
  const documentName = docPath(fileId)
  const previous = new Y.Doc()
  Y.applyUpdate(previous, new Uint8Array(old))
  const connection = await collab().openDirectConnection(documentName, context)
  try {
    await saveVersion(documentName, connection.document as Document, true)
    await connection.transact((doc) => restoreInto(doc, previous))
  } finally {
    await connection.disconnect()
    previous.destroy()
  }
}
