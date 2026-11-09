import { and, desc, eq, inArray } from "drizzle-orm"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { db, docContents, docVersions, users } from "../db"
import { authMiddleware, bearerOf, extractAuthToken } from "../middleware/auth"
import { KEPT_VERSIONS, restoreVersion } from "../services/collab"
import { closeShare, docsForEvent, findOpenShare, openShare, openSharesIn, openShareForGuest, passGuest } from "../services/docCalls"
import {
  addComment,
  commentsDoc,
  deleteComment,
  editComment,
  findComment,
  hideThread,
  listThreads,
  type CommentRow,
} from "../services/docComments"
import { callPeople, createDoc, docLevelFor, docPeople, guestDocLevel, type DocRow } from "../services/docs"
import { loadedFileDto, resolvePlace } from "../services/fileQueries"
import { loadFileFacts, type FileViewer } from "../services/files"
import { inRoom } from "../services/liveRooms"
import { verifyAuthToken } from "../services/sessions"
import { orgMiddleware, viewerFor } from "../services/tenancy"
import { serverInstant } from "../utils/chatAccess"
import { AI_WORDS, saidByAi } from "../utils/aiTypes"
import { canSeeComments } from "../utils/docAccess"
import { guestDocClaims, signGuestDocToken, type GuestDocClaims } from "../utils/docCalls"
import { canonicalRoom, foreignRoom, roomKind } from "../utils/meetingRooms"
import { presenceName } from "../utils/presence"
import { viaOf } from "../utils/via"
import { addedAiMention, mentionsAi } from "../utils/mentions"
import { mentionAi } from "../services/aiMention"
import { parseBody, parseParams, parseQuery } from "../validation/helpers"
import {
  callShareCreateBodySchema,
  callSharesQuerySchema,
  docCommentParamsSchema,
  docCommentPatchBodySchema,
  docCommentPostBodySchema,
  docCreateBodySchema,
  docQuerySchema,
  docVersionParamsSchema,
  docsForEventParamsSchema,
  docsForEventQuerySchema,
  fileIdParamsSchema,
  guestTokenBodySchema,
} from "../validation/schemas"
import { READ_ONLY } from "./helpers"

const GONE = { error: "Not found" }
const EDITORS_ONLY = { error: "Only people who can edit this can see its history" }
const VERSION_GONE = { error: "Version not found" }
const COMMENT_GONE = { error: "Comment not found" }
const NOT_IN_CALL = { error: "Join the call to show a paper in it" }
const BAD_ROOM = { error: "Invalid room name" }
const EDITORS_DRAW = { error: "Only people who can edit this board can change its picture" }
const BOARDS_ONLY = { error: "Only boards have a thumbnail" }
const NOT_PNG = { error: "The thumbnail must be a PNG of at most 200 KB" }

/** A board's preview picture, small enough to keep next to its state */
const THUMBNAIL_MAX_BYTES = 200 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A guest in a call sends their doc token in this header */
const DOC_TOKEN_HEADER = "x-doc-token"

const docTokenOf = (request: FastifyRequest): string | null => {
  const value = request.headers[DOC_TOKEN_HEADER]
  return typeof value === "string" && value ? value : null
}

/** A room name as calls store it, or null when it names no kind of room */
function callRoom(raw: string): string | null {
  const room = canonicalRoom(raw)
  return roomKind(room).kind === "invalid" ? null : room
}

/** The doc a guest's doc token reaches right now, or null */
async function guestDoc(
  request: FastifyRequest,
  fileId: string,
): Promise<(Awaited<ReturnType<typeof guestDocLevel>> & { claims: GuestDocClaims }) | null> {
  const token = docTokenOf(request)
  const claims = token ? guestDocClaims(token, new Date()) : null
  if (!claims || claims.fileId !== fileId) return null
  const access = await guestDocLevel(claims)
  return access ? { ...access, claims } : null
}

/** The member checks the hooks run, for routes that also take guests. False when a refusal was sent */
async function asMember(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  await authMiddleware(request, reply)
  if (reply.sent) return false
  await orgMiddleware(request, reply)
  return !reply.sent
}

/** The doc when the caller can edit it, or the reply already sent */
async function editableDoc(
  id: string,
  request: FastifyRequest,
  reply: FastifyReply,
  refusal = EDITORS_ONLY,
): Promise<{ file: DocRow; v: FileViewer } | null> {
  const query = parseQuery(docQuerySchema, request.query, reply)
  if (!query) return null
  const v = viewerFor(request)
  const { file, level } = await docLevelFor(id, v, undefined, { shareId: query.shareId })
  if (!file || !level) {
    reply.code(404).send(GONE)
    return null
  }
  if (level !== "edit") {
    reply.code(403).send(refusal)
    return null
  }
  return { file, v }
}

/** The comment and its doc when the caller can see the doc's comments, or the reply already sent */
async function reachableComment(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ comment: CommentRow; file: DocRow; v: FileViewer; shareId: string | null } | null> {
  const params = parseParams(docCommentParamsSchema, request.params, reply)
  if (!params) return null
  const query = parseQuery(docQuerySchema, request.query, reply)
  if (!query) return null
  const v = viewerFor(request)
  const comment = await findComment(params.commentId, v.organizationId)
  const file = comment ? await commentsDoc(comment.fileId, v, query.shareId) : null
  if (!comment || !file) {
    reply.code(404).send(COMMENT_GONE)
    return null
  }
  return { comment, file, v, shareId: query.shareId ?? null }
}

/** Asks the AI in the thread of a comment that tags it */
function askAiInThread(v: FileViewer, fileId: string, comment: { id: string; parentId: string | null }, text: string) {
  mentionAi({
    asker: { userId: v.userId, organizationId: v.organizationId, isAdmin: v.isOrgAdmin },
    place: { kind: "doc_comment", fileId, commentId: comment.parentId ?? comment.id },
    text,
    source: { kind: "doc_comment", id: comment.id },
  })
}

async function versionState(fileId: string, versionId: string, organizationId: string): Promise<Buffer | null> {
  const [row] = await db
    .select({ state: docVersions.state })
    .from(docVersions)
    .where(and(eq(docVersions.id, versionId), eq(docVersions.fileId, fileId), eq(docVersions.organizationId, organizationId)))
  return row?.state ?? null
}

async function memberRoutes(fastify: FastifyInstance) {
  // A guest's doc token opens none of these, and a guest learns nothing from being refused
  fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (docTokenOf(request) && !extractAuthToken(request)) return reply.code(404).send(GONE)
  })
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(docCreateBodySchema, request.body, reply)
    if (!body) return
    const v = viewerFor(request)
    const place = await resolvePlace(v, body.projectId ?? null, body.folderId ?? null)
    if (!place) return reply.code(404).send({ error: "Folder not found" })
    if (place === "read-only") return reply.code(403).send(READ_ONLY)
    const id = await createDoc(v, body.docType, place, body.name, viaOf(request))
    const loaded = await loadFileFacts(id, v)
    return reply.code(201).send(loaded ? await loadedFileDto(loaded) : { id })
  })

  fastify.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const query = parseQuery(docQuerySchema, request.query, reply)
    if (!query) return
    const { loaded, level } = await docLevelFor(params.id, viewerFor(request), undefined, { shareId: query.shareId })
    if (!loaded || !level) return reply.code(404).send(GONE)
    return reply.send({
      file: await loadedFileDto(loaded),
      docType: loaded.file.docType,
      level,
      canComment: canSeeComments(level),
    })
  })

  fastify.addContentTypeParser("image/png", { parseAs: "buffer", bodyLimit: THUMBNAIL_MAX_BYTES }, (_request, body, done) =>
    done(null, body),
  )

  fastify.get("/:id/thumbnail", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const query = parseQuery(docQuerySchema, request.query, reply)
    if (!query) return
    const v = viewerFor(request)
    const { file, level } = await docLevelFor(params.id, v, undefined, { shareId: query.shareId })
    if (!file || !level || file.docType !== "board") return reply.code(404).send(GONE)
    const [row] = await db
      .select({ thumbnail: docContents.thumbnail })
      .from(docContents)
      .where(and(eq(docContents.fileId, file.id), eq(docContents.organizationId, v.organizationId)))
    if (!row?.thumbnail) return reply.code(404).send(GONE)
    return reply.header("Content-Type", "image/png").header("Cache-Control", "private, no-store").send(row.thumbnail)
  })

  fastify.put("/:id/thumbnail", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const doc = await editableDoc(params.id, request, reply, EDITORS_DRAW)
    if (!doc) return
    if (doc.file.docType !== "board") return reply.code(400).send(BOARDS_ONLY)
    const body = request.body
    const png = Buffer.isBuffer(body) && body.length <= THUMBNAIL_MAX_BYTES && body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    if (!png) return reply.code(400).send(NOT_PNG)
    await db
      .update(docContents)
      .set({ thumbnail: body })
      .where(and(eq(docContents.fileId, doc.file.id), eq(docContents.organizationId, doc.v.organizationId)))
    return reply.code(204).send()
  })

  fastify.get("/:id/people", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const query = parseQuery(docQuerySchema, request.query, reply)
    if (!query) return
    const v = viewerFor(request)
    // The list only feeds mentions, which viewers can't make
    const { file, level } = await docLevelFor(params.id, v, undefined, { shareId: query.shareId })
    if (!file || !canSeeComments(level)) return reply.code(404).send(GONE)
    // A user who comments only through a call share learns who is in the call, never who else has the doc
    if (query.shareId && !canSeeComments((await docLevelFor(params.id, v)).level)) {
      return reply.send({ people: await callPeople(query.shareId, v.organizationId) })
    }
    return reply.send({ people: await docPeople(file, v.organizationId) })
  })

  fastify.patch("/comments/:commentId", async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await reachableComment(request, reply)
    if (!found) return
    const { comment, file, v, shareId } = found
    if (comment.deletedAt) return reply.code(404).send(COMMENT_GONE)
    if (comment.authorId !== v.userId) return reply.code(403).send({ error: "Only its author can change a comment" })
    if (saidByAi(comment.doneVia)) return reply.code(403).send({ error: AI_WORDS })
    const body = parseBody(docCommentPatchBodySchema, request.body, reply)
    if (!body) return
    const updated = await editComment(comment, v, body.body)
    if (!updated) return reply.code(404).send(COMMENT_GONE)
    // A tag added by the edit asks the AI, by the same rules as a new comment, unless the comment asked before
    if (!viaOf(request) && !shareId && addedAiMention(comment.body, body.body)) askAiInThread(v, file.id, comment, body.body)
    return reply.send(updated)
  })

  fastify.delete("/comments/:commentId", async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await reachableComment(request, reply)
    if (!found) return
    const { comment, file, v } = found
    if (comment.deletedAt) return reply.code(404).send(COMMENT_GONE)
    if (comment.authorId !== v.userId && file.uploadedBy !== v.userId) {
      return reply.code(403).send({ error: "Only its author or the owner can delete a comment" })
    }
    if (!(await deleteComment(comment, v.organizationId))) return reply.code(404).send(COMMENT_GONE)
    return reply.code(204).send()
  })

  fastify.post("/comments/:commentId/hide", async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await reachableComment(request, reply)
    if (!found) return
    const { comment, v } = found
    if (comment.parentId) return reply.code(400).send({ error: "Only a whole thread can be hidden" })
    await hideThread(comment, v)
    return reply.code(204).send()
  })

  fastify.get("/:id/versions", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const doc = await editableDoc(params.id, request, reply)
    if (!doc) return
    const { organizationId } = doc.v
    const rows = await db
      .select({ id: docVersions.id, createdAt: docVersions.createdAt, editorIds: docVersions.editorIds, via: docVersions.via })
      .from(docVersions)
      .where(and(eq(docVersions.fileId, params.id), eq(docVersions.organizationId, organizationId)))
      .orderBy(desc(docVersions.createdAt), desc(docVersions.id))
    const ids = [...new Set(rows.flatMap((row) => row.editorIds))]
    const people = ids.length
      ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, ids))
      : []
    const names = new Map(people.map((person) => [person.id, presenceName(person.firstName, person.lastName)]))
    // The first version of a doc the AI or an agent made is its making, while none has been dropped yet
    const made = !!doc.file.doneVia && rows.length < KEPT_VERSIONS ? rows.at(-1)?.id : undefined
    return reply.send(
      rows.map((row) => ({
        id: row.id,
        createdAt: new Date(serverInstant(row.createdAt)).toISOString(),
        editors: row.editorIds.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! })),
        done_via: row.via ?? null,
        ...(row.id === made && row.via ? { created: true } : {}),
      })),
    )
  })

  fastify.get("/:id/versions/:versionId", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(docVersionParamsSchema, request.params, reply)
    if (!params) return
    const doc = await editableDoc(params.id, request, reply)
    if (!doc) return
    const state = await versionState(params.id, params.versionId, doc.v.organizationId)
    if (!state) return reply.code(404).send(VERSION_GONE)
    return reply.send({ state: state.toString("base64") })
  })

  fastify.post("/:id/versions/:versionId/restore", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(docVersionParamsSchema, request.params, reply)
    if (!params) return
    const doc = await editableDoc(params.id, request, reply)
    if (!doc) return
    const { v, file } = doc
    const state = await versionState(params.id, params.versionId, v.organizationId)
    if (!state) return reply.code(404).send(VERSION_GONE)
    await restoreVersion(
      file.id,
      { organizationId: v.organizationId, userId: v.userId, guest: null, level: "edit", shareId: null, sessionToken: null },
      state,
    )
    return reply.code(204).send()
  })

  fastify.post("/call-shares", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(callShareCreateBodySchema, request.body, reply)
    if (!body) return
    const v = viewerFor(request)
    const roomName = callRoom(body.roomName)
    if (!roomName) return reply.code(400).send(BAD_ROOM)
    if (foreignRoom(roomName, v.organizationId) || !(await inRoom(roomName, v.userId))) return reply.code(403).send(NOT_IN_CALL)
    const opened = await openShare(v, { ...body, roomName })
    if (!opened) return reply.code(404).send(GONE)
    return reply.code(201).send({ share: opened.share, file: await loadedFileDto(opened.loaded) })
  })

  fastify.delete("/call-shares/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const v = viewerFor(request)
    const share = await findOpenShare(params.id, v.organizationId)
    if (!share || (share.openedBy !== v.userId && share.ownerId !== v.userId)) return reply.code(404).send(GONE)
    await closeShare(share.id, v.organizationId)
    return reply.code(204).send()
  })

  fastify.get("/for-event/:eventId", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(docsForEventParamsSchema, request.params, reply)
    if (!params) return
    const query = parseQuery(docsForEventQuerySchema, request.query, reply)
    if (!query) return
    const docs = await docsForEvent(viewerFor(request), params.eventId, query)
    return reply.send(await Promise.all(docs.map((doc) => loadedFileDto(doc))))
  })
}

/** Routes a guest in a call reaches too, with their doc token or LiveKit token. Each decides who is asking */
async function callRoutes(fastify: FastifyInstance) {
  fastify.get("/:id/comments", async (request: FastifyRequest, reply: FastifyReply) => {
    if (docTokenOf(request)) {
      const params = fileIdParamsSchema.safeParse(request.params)
      const guest = params.success ? await guestDoc(request, params.data.id) : null
      if (!guest || !canSeeComments(guest.level)) return reply.code(404).send(GONE)
      return reply.send({ threads: await listThreads(guest.file, { organizationId: guest.organizationId, userId: null }) })
    }
    if (!(await asMember(request, reply))) return
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const query = parseQuery(docQuerySchema, request.query, reply)
    if (!query) return
    const v = viewerFor(request)
    const file = await commentsDoc(params.id, v, query.shareId)
    if (!file) return reply.code(404).send(GONE)
    return reply.send({ threads: await listThreads(file, v) })
  })

  fastify.post("/:id/comments", async (request: FastifyRequest, reply: FastifyReply) => {
    if (docTokenOf(request)) {
      const params = fileIdParamsSchema.safeParse(request.params)
      const guest = params.success ? await guestDoc(request, params.data.id) : null
      if (!guest || !canSeeComments(guest.level)) return reply.code(404).send(GONE)
      const body = parseBody(docCommentPostBodySchema, request.body, reply)
      if (!body) return
      const comment = await addComment(
        guest.file,
        { organizationId: guest.organizationId, userId: null, guestName: guest.claims.name },
        body,
      )
      if (!comment) return reply.code(404).send(COMMENT_GONE)
      return reply.code(201).send(comment)
    }
    if (!(await asMember(request, reply))) return
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const query = parseQuery(docQuerySchema, request.query, reply)
    if (!query) return
    const v = viewerFor(request)
    const file = await commentsDoc(params.id, v, query.shareId)
    if (!file) return reply.code(404).send(GONE)
    const body = parseBody(docCommentPostBodySchema, request.body, reply)
    if (!body) return
    const comment = await addComment(file, { ...v, via: viaOf(request) }, body)
    if (!comment) return reply.code(404).send(COMMENT_GONE)
    // A user who reaches the paper only through a call is not one of its members, so the AI stays out of it
    if (!viaOf(request) && !query.shareId && mentionsAi(body.body)) askAiInThread(v, file.id, comment, body.body)
    return reply.code(201).send(comment)
  })

  /** The call's open shares, for a member in the call or a guest with their call pass */
  fastify.get("/call-shares", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractAuthToken(request)
    const session = token ? await verifyAuthToken(fastify, token) : null
    if (session) {
      request.user = session
      await orgMiddleware(request, reply)
      if (reply.sent) return
      const query = parseQuery(callSharesQuerySchema, request.query, reply)
      if (!query) return
      const roomName = callRoom(query.roomName)
      if (!roomName) return reply.code(400).send(BAD_ROOM)
      const v = viewerFor(request)
      if (foreignRoom(roomName, v.organizationId) || !(await inRoom(roomName, v.userId))) return reply.code(404).send(GONE)
      return reply.send({ shares: await openSharesIn(roomName, v.organizationId) })
    }
    const bearer = bearerOf(request)
    if (!bearer) return reply.code(401).send({ error: "Access denied. No token provided." })
    const query = callSharesQuerySchema.safeParse(request.query)
    const guest = await passGuest(bearer)
    const roomName = query.success ? callRoom(query.data.roomName) : null
    if (!guest || !roomName || guest.roomName !== roomName) return reply.code(404).send(GONE)
    // A guest needs the name of whoever showed it, never their id
    const shares = await openSharesIn(roomName, null)
    return reply.send({ shares: shares.map((share) => ({ ...share, openedBy: { name: share.openedBy.name } })) })
  })

  /** A 10 minute doc token for a guest in the call, for one open share. The guest proves who they are with their call pass */
  fastify.post("/guest-token", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store")
    const body = parseBody(guestTokenBodySchema, request.body, reply)
    if (!body) return
    const now = new Date()
    const share = await openShareForGuest(body.shareId)
    if (!share) return reply.code(404).send(GONE)
    const bearer = bearerOf(request)
    const guest = bearer ? await passGuest(bearer) : null
    if (!guest || guest.roomName !== share.roomName) return reply.code(404).send(GONE)
    const { token, expiresAt } = signGuestDocToken(
      { shareId: share.id, fileId: share.fileId, identity: guest.identity, name: guest.name },
      now,
    )
    return reply.send({ token, expiresAt: expiresAt.toISOString(), fileId: share.fileId, level: share.level })
  })
}

async function paperRoutes(fastify: FastifyInstance) {
  await fastify.register(memberRoutes)
  await fastify.register(callRoutes)
}

export default paperRoutes
