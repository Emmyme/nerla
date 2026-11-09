import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { authMiddleware } from "../middleware/auth"
import { orgMiddleware, orgOf, viewerFor } from "../services/tenancy"
import { db, fileAttachments, fileFolders, fileLinks, messages, tasks, taskComments, users, type Executor } from "../db"
import { chatForMessage, loadMessageDto } from "../services/chats"
import { attachmentDto, dropStoredObjects, LINKED_FILES, linkFiles, loadFileFacts, messageProjectId, type FileRow } from "../services/files"
import { emitToChat } from "../services/websocket"
import { eq, and, count, gt, isNull, sql } from "drizzle-orm"
import { deleteObject, objectKey, putObjectStream, sendDownload, storageRefusal } from "../services/storage"
import { capsAndUsage, lockUsage, resolvePlace } from "../services/fileQueries"
import type { MultipartFile } from "@fastify/multipart"
import { Readable } from "stream"
import { parseBody, parseParams, parseQuery } from "../validation/helpers"
import { fileAttachBodySchema, fileDownloadQuerySchema, fileIdParamsSchema, fileUploadQuerySchema } from "../validation/schemas"
import { isSafeInlineImageType, MIME_HEAD_BYTES, validateFileMime } from "../utils/mimeValidation"
import { logger } from "../utils/logger"
import { capCheck, maxFileOf } from "../utils/storageCaps"
import { taskAccessLevel } from "../utils/taskAccess"
import { liveTask } from "../utils/trash"
import { callerMembership } from "../services/projectAccess"
import { can } from "../utils/fileAccess"
import { docLevelFor } from "../services/docs"
import { guestDocImage } from "../services/docCalls"
import { guestDocClaims } from "../utils/docCalls"
import type { ChatRef } from "../utils/chatAccess"
import { READ_ONLY } from "./helpers"

const downloadRateLimit = { max: 300, timeWindow: "1 minute" as const }
/** Room for the multipart boundary and part headers, so the early check never refuses a file that fits */
const MULTIPART_SLACK = 16 * 1024

const AVATAR_MAX_BYTES = 5 * 1024 * 1024
const AVATARS_PER_DAY = 20
const AVATAR_LIMIT = { status: 429, error: "You've changed your picture a lot today. Try again tomorrow." }
const FOLDER_TRASHED = { status: 409, error: "That folder was moved to the trash while the file uploaded." }
const FILE_GONE = { error: "File not found" }
const DOC_DOWNLOAD = { error: "Papers and boards download as PDF from their editor" }

class FileTooLarge extends Error {}

const isTooLarge = (error: unknown) =>
  error instanceof FileTooLarge || (error as { code?: string } | null)?.code === "FST_REQ_FILE_TOO_LARGE"

// An upload that failed has no record, often because the database failed, so the delete is tried first and queued only when it fails
async function deleteQuietly(key: string): Promise<void> {
  await deleteObject(key)
    .catch(() => dropStoredObjects(db, [key]))
    .catch((error) => logger.error(`A failed upload left its stored object ${key} behind`, error))
}

async function avatarsToday(userId: string, executor: Executor = db): Promise<number> {
  // tenancy: a user's pictures count across every workspace
  const [{ today }] = await executor
    .select({ today: count() })
    .from(fileAttachments)
    .where(
      and(
        eq(fileAttachments.kind, "avatar"),
        eq(fileAttachments.uploadedBy, userId),
        gt(fileAttachments.createdAt, sql`now() - interval '1 day'`),
      ),
    )
  return today
}

/** A name that fits the column. The name is data and is never trusted */
const storedName = (name: string) => [...(name || "file")].slice(0, 255).join("")

/**
 * Streams the part to `key`. The first bytes are checked for executables before anything is written, and a part
 * that runs over `limit` fails the write, so no partial object stays behind
 */
async function streamToStore(
  part: MultipartFile,
  key: string,
  limit: number,
  refuse: (mimeType: string) => string | null,
): Promise<{ refused: string } | { mimeType: string; size: number }> {
  const chunks = part.file[Symbol.asyncIterator]()
  const first: Buffer[] = []
  let size = 0
  let ended = false
  while (size < MIME_HEAD_BYTES) {
    const next = await chunks.next()
    if (next.done) {
      ended = true
      break
    }
    first.push(next.value)
    size += next.value.length
  }
  const head = Buffer.concat(first)
  const mime = validateFileMime(head.subarray(0, MIME_HEAD_BYTES), part.mimetype)
  const refused = mime.valid ? refuse(mime.mimeType) : mime.reason
  if (!mime.valid || refused) {
    // The rest of the body is read and dropped, so the answer reaches the client
    while (!ended && !(await chunks.next()).done);
    return { refused: refused ?? "File type not allowed" }
  }

  async function* body() {
    if (head.length > 0) yield head
    while (!ended) {
      const next = await chunks.next()
      if (next.done) break
      size += next.value.length
      yield next.value
    }
    if (part.file.truncated || size > limit) throw new FileTooLarge()
  }
  await putObjectStream(key, Readable.from(body()), mime.mimeType)
  return { mimeType: mime.mimeType, size }
}

/** The file when the caller may view it. Anything else looks like an id nobody has */
async function viewableFile(request: FastifyRequest, id: string): Promise<FileRow | null> {
  const loaded = await loadFileFacts(id, viewerFor(request))
  return loaded && can("view", loaded.facts, loaded.viewer) ? loaded.file : null
}

/** A guest in a call loads a paper's images with their doc token, and the download route decides */
const docGuestDownload = (request: FastifyRequest) =>
  request.method === "GET" && !!request.headers["x-doc-token"] && !!request.routeOptions.url?.endsWith("/:id/download")

async function fileRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (docGuestDownload(request)) return
    await authMiddleware(request, reply)
    if (reply.sent) return reply
    await orgMiddleware(request, reply)
    if (reply.sent) return reply
  })

  fastify.post("/upload", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = parseQuery(fileUploadQuerySchema, request.query, reply)
    if (!query) return
    const purpose = query.purpose ?? "draft"
    const viewer = viewerFor(request)
    const { organizationId, userId } = viewer

    let place = { projectId: null as string | null, folderId: null as string | null }
    if (purpose === "file") {
      const resolved = await resolvePlace(viewer, query.projectId ?? null, query.folderId ?? null)
      if (!resolved) return reply.code(404).send({ error: "Folder not found" })
      if (resolved === "read-only") return reply.code(403).send(READ_ONLY)
      place = resolved
    }
    // An image in a paper or board belongs to it, owned like the doc and counted toward the doc's owner or project.
    // Editing through a call share is editing, so the share counts as it does for downloads
    let owner = userId
    let docId: string | null = null
    if (purpose === "doc") {
      const doc = await docLevelFor(query.docId!, viewer, undefined, { shareId: query.shareId })
      if (!doc.file || !doc.level) return reply.code(404).send(FILE_GONE)
      if (doc.level !== "edit") return reply.code(403).send({ error: "You can't edit this" })
      owner = doc.file.uploadedBy
      docId = doc.file.id
      place = { projectId: doc.file.projectId, folderId: null }
    }
    const projectFile = place.projectId !== null

    // Avatars stay out of usage, with a small limit of their own that a lower workspace maximum still lowers
    const avatar = purpose === "avatar"
    if (avatar && (await avatarsToday(userId)) >= AVATARS_PER_DAY) return reply.code(429).send({ error: AVATAR_LIMIT.error })
    const counter = { ...viewer, userId: owner }
    const limits = await capsAndUsage(counter)
    const caps = avatar
      ? {
          perPerson: null,
          total: null,
          maxFile: Math.min(AVATAR_MAX_BYTES, limits.caps.maxFile ?? AVATAR_MAX_BYTES),
          ceiling: limits.caps.ceiling,
        }
      : limits.caps
    const counted = avatar ? { person: 0, workspace: 0 } : limits.usage
    const declared = Number(request.headers["content-length"])
    if (Number.isFinite(declared)) {
      const early = capCheck(Math.max(0, declared - MULTIPART_SLACK), counted, caps, projectFile)
      if (!early.ok) return reply.code(413).send({ error: early.reason, limit: early.limit })
    }
    const refuseType = (mimeType: string) =>
      avatar && !isSafeInlineImageType(mimeType)
        ? "Profile pictures must be an image."
        : docId && !isSafeInlineImageType(mimeType)
          ? "Only images go into papers and boards."
          : null

    const maxFile = maxFileOf(caps)
    const tooLarge = () => reply.code(413).send({ error: "file-too-large", limit: maxFile })
    let part: MultipartFile | undefined
    try {
      part = await request.file({ limits: { fileSize: maxFile, files: 1 } })
    } catch (error) {
      if (isTooLarge(error)) return tooLarge()
      throw error
    }
    if (!part) return reply.code(400).send({ error: "No file provided" })

    const key = objectKey(avatar ? "avatar" : "attachment", organizationId, owner, part.filename)
    let stored: { mimeType: string; size: number }
    try {
      const streamed = await streamToStore(part, key, maxFile, refuseType)
      if ("refused" in streamed) return reply.code(400).send({ error: streamed.refused })
      stored = streamed
    } catch (error) {
      await deleteQuietly(key)
      if (isTooLarge(error) || part.file.truncated) return tooLarge()
      const refusal = storageRefusal(error)
      if (refusal) return reply.code(refusal.status).header("Connection", "close").send({ error: refusal.error })
      logger.error("Upload failed", error)
      return reply.code(500).header("Connection", "close").send({ error: "Failed to upload file" })
    }

    try {
      const name = storedName(part.filename)
      const saved = await db.transaction(async (tx) => {
        if (avatar) {
          // Uploads sent at once each passed the early count, so it is taken again one at a time
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`avatar:${userId}`}, 0))`)
          if ((await avatarsToday(userId, tx)) >= AVATARS_PER_DAY) return AVATAR_LIMIT
        } else {
          await lockUsage(tx, organizationId)
          const fresh = await capsAndUsage(counter, tx)
          const verdict = capCheck(stored.size, fresh.usage, caps, projectFile)
          if (!verdict.ok) return verdict
        }
        if (place.folderId) {
          const [folder] = await tx
            .select({ id: fileFolders.id })
            .from(fileFolders)
            .where(and(eq(fileFolders.id, place.folderId), eq(fileFolders.organizationId, organizationId), isNull(fileFolders.deletedAt)))
            .for("share")
          if (!folder) return FOLDER_TRASHED
        }
        const [row] = await tx
          .insert(fileAttachments)
          .values({
            fileName: name,
            filePath: key,
            fileSize: stored.size,
            mimeType: stored.mimeType,
            uploadedBy: owner,
            organizationId,
            kind: avatar ? "avatar" : docId ? "docimage" : "file",
            docFileId: docId,
            // Composers upload only to post, so their files stay drafts until posted
            isDraft: purpose === "draft",
            projectId: place.projectId,
            folderId: place.folderId,
          })
          .returning()
        return row
      })
      if ("reason" in saved) {
        await deleteQuietly(key)
        return reply.code(413).send({ error: saved.reason, limit: saved.limit })
      }
      if ("status" in saved) {
        await deleteQuietly(key)
        return reply.code(saved.status).send({ error: saved.error })
      }
      return reply.send({
        id: saved.id,
        fileName: saved.fileName,
        fileSize: saved.fileSize,
        mimeType: saved.mimeType,
        createdAt: saved.createdAt,
      })
    } catch (error) {
      await deleteQuietly(key)
      logger.error("Saving the upload failed", error)
      return reply.code(500).send({ error: "Failed to upload file" })
    }
  })

  fastify.post("/attach", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const body = parseBody(fileAttachBodySchema, request.body, reply)
    if (!body) return
    const { organizationId, role } = orgOf(request)
    const isOrgAdmin = role === "admin"

    try {
      const loaded = await loadFileFacts(body.fileId, viewerFor(request))
      if (!loaded || !can("view", loaded.facts, loaded.viewer)) {
        return reply.code(404).send(FILE_GONE)
      }

      let projectId: string | null = null
      let chat: ChatRef | null = null
      if (body.messageId) {
        const message = await db.query.messages.findFirst({
          where: and(eq(messages.id, body.messageId), eq(messages.organizationId, organizationId)),
        })
        // Only the sender, while still in the chat and its organization
        chat = message && message.senderId === user.id ? await chatForMessage(organizationId, user.id, message) : null
        if (!message || !chat) {
          return reply.code(404).send({ error: "Message not found" })
        }
        projectId = await messageProjectId(message, organizationId)
      } else if (body.taskId) {
        const task = await db.query.tasks.findFirst({
          where: and(eq(tasks.id, body.taskId), eq(tasks.organizationId, organizationId), liveTask),
          with: { project: { with: callerMembership(user.id) } },
        })
        const level = task ? taskAccessLevel(task, user.id, organizationId, isOrgAdmin) : null
        if (!task || !level) return reply.code(404).send({ error: "Task not found" })
        if (level !== "member") return reply.code(403).send(READ_ONLY)
        projectId = task.projectId
      } else if (body.commentId) {
        const comment = await db.query.taskComments.findFirst({
          where: and(eq(taskComments.id, body.commentId), eq(taskComments.organizationId, organizationId)),
          with: { task: { with: { project: { with: callerMembership(user.id) } } } },
        })
        // A comment's files are its author's to change
        const level = comment ? taskAccessLevel(comment.task, user.id, organizationId, isOrgAdmin) : null
        if (!comment || !level || (level === "member" && comment.userId !== user.id)) {
          return reply.code(404).send({ error: "Comment not found" })
        }
        if (level !== "member") return reply.code(403).send(READ_ONLY)
        projectId = comment.task.projectId
      }

      const target = { messageId: body.messageId, taskId: body.taskId, commentId: body.commentId }
      const linked = await db.transaction((tx) => linkFiles(target, [body.fileId], { userId: user.id, organizationId }, projectId, tx))
      if (linked.length === 0) {
        return reply.code(400).send({ error: "This file can't be attached here" })
      }

      if (chat && body.messageId) {
        const dto = await loadMessageDto(body.messageId)
        if (dto) emitToChat(organizationId, chat, "message-updated", { message: dto })
      }

      const link = await db.query.fileLinks.findFirst({
        where: and(
          eq(fileLinks.fileId, body.fileId),
          body.messageId
            ? eq(fileLinks.messageId, body.messageId)
            : body.taskId
              ? eq(fileLinks.taskId, body.taskId)
              : eq(fileLinks.commentId, body.commentId!),
          eq(fileLinks.organizationId, organizationId),
        ),
        with: LINKED_FILES.with,
      })
      return reply.send(link ? attachmentDto(link.file, link) : { id: body.fileId })
    } catch (error) {
      logger.error("Attaching a file failed", error)
      return reply.code(500).send({ error: "Failed to attach file" })
    }
  })

  fastify.get(
    "/:id/download",
    // Grid thumbnails are downloads, so the route has room beyond the global limit
    { config: { rateLimit: downloadRateLimit } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = parseParams(fileIdParamsSchema, request.params, reply)
      if (!params) return
      const { id } = params
      const query = parseQuery(fileDownloadQuerySchema, request.query, reply)
      if (!query) return

      try {
        if (docGuestDownload(request)) {
          const claims = guestDocClaims(String(request.headers["x-doc-token"]), new Date())
          const image = claims && (!query.doc || claims.fileId === query.doc) ? await guestDocImage(id, claims) : null
          if (!image) return reply.code(404).send(FILE_GONE)
          return sendDownload(reply, image, request.log)
        }
        const viewer = viewerFor(request)
        const loaded = await loadFileFacts(id, viewer)
        if (query.doc && (loaded?.file.kind !== "docimage" || loaded.file.docFileId !== query.doc)) {
          return reply.code(404).send(FILE_GONE)
        }
        // A doc's image is open to every member with a level on its doc, a call share's included
        if (loaded?.file.kind === "docimage" && loaded.file.docFileId) {
          const doc = await docLevelFor(loaded.file.docFileId, viewer, undefined, { shareId: query.share })
          if (!doc.level) return reply.code(404).send(FILE_GONE)
          return sendDownload(reply, loaded.file, request.log)
        }
        if (!loaded || !can("view", loaded.facts, loaded.viewer)) {
          return reply.code(404).send(FILE_GONE)
        }
        if (loaded.file.docType) return reply.code(409).send(DOC_DOWNLOAD)
        return sendDownload(reply, loaded.file, request.log)
      } catch (error) {
        logger.error("Downloading a file failed", error)
        return reply.code(500).send({ error: "Failed to download file" })
      }
    },
  )

  fastify.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return

    try {
      const attachment = await viewableFile(request, params.id)
      if (!attachment) {
        return reply.code(404).send(FILE_GONE)
      }

      const uploader = await db.query.users.findFirst({
        where: eq(users.id, attachment.uploadedBy),
        columns: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true },
      })

      return reply.send({
        id: attachment.id,
        fileName: attachment.fileName,
        fileSize: attachment.fileSize,
        mimeType: attachment.mimeType,
        createdAt: attachment.createdAt,
        uploader: uploader
          ? {
              id: uploader.id,
              email: uploader.email,
              first_name: uploader.firstName,
              last_name: uploader.lastName,
              avatar_url: uploader.avatarUrl,
            }
          : null,
      })
    } catch (error) {
      logger.error("Fetching a file failed", error)
      return reply.code(500).send({ error: "Failed to fetch file" })
    }
  })
}

export default fileRoutes
