import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { randomUUID } from "node:crypto"
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { db, docContents, docVersions, fileAttachments, fileFolders } from "../db"
import { authMiddleware } from "../middleware/auth"
import {
  asProjectViewer,
  capsAndUsage,
  contextLines,
  decodeCursor,
  fileDto,
  folderDto,
  folderTrail,
  listFiles,
  listFolders,
  loadedFileDto,
  loadedFolderDto,
  lockUsage,
  placeFolder,
  resolvePlace,
  searchFiles,
  searchFolders,
  SEARCH_LIMIT,
  type BrowseOptions,
  type FileQueryRow,
} from "../services/fileQueries"
import {
  dropStoredObjects,
  folderAncestors,
  folderFacts,
  loadFileFacts,
  purgeFile,
  restoreFile,
  restoreFolder,
  trashFile,
  trashFolder,
  type FileChange,
  type FileViewer,
  type Refused,
} from "../services/files"
import { docCopy, isDoc } from "../services/docs"
import { ADMIN_VIEWER, projectAccess, projectReadAccess } from "../services/projectAccess"
import { copyObject, deleteObject, objectKey, storageRefusal } from "../services/storage"
import { orgMiddleware, viewerFor } from "../services/tenancy"
import { docPath } from "../utils/docAccess"
import { can } from "../utils/fileAccess"
import { capCheck, type CapRefusal } from "../utils/storageCaps"
import { viaOf } from "../utils/via"
import { parseBody, parseParams, parseQuery } from "../validation/helpers"
import {
  fileBrowseQuerySchema,
  fileIdParamsSchema,
  filePatchBodySchema,
  fileSearchQuerySchema,
  folderCreateBodySchema,
  folderPatchBodySchema,
} from "../validation/schemas"
import { READ_ONLY } from "./helpers"

const FILE_GONE = { error: "File not found" }
const FOLDER_GONE = { error: "Folder not found" }
const NOT_YOURS = { error: "You can't change this" }

/** A refused change answers 403 when the viewer can see the item only as a workspace admin outside its project */
async function refusedChange(kind: "file" | "folder", id: string, v: FileViewer, reply: FastifyReply) {
  const loaded = kind === "file" ? await loadFileFacts(id, v) : await folderFacts(id, v, db)
  if (loaded && loaded.viewer.projectRole === "viewer" && can("view", loaded.facts, loaded.viewer)) {
    return reply.code(403).send(READ_ONLY)
  }
  return reply.code(404).send(kind === "file" ? FILE_GONE : FOLDER_GONE)
}

async function listReply(v: FileViewer, files: FileQueryRow[], folders: Parameters<typeof folderDto>[0][], nextCursor: string | null) {
  const [contexts, { caps, usage }] = await Promise.all([contextLines(v, files), capsAndUsage(v)])
  return {
    folders: folders.map((folder) => folderDto(folder, v)),
    files: files.map((file) => fileDto(file, v, contexts.get(file.id) ?? null)),
    usage: { used: usage.person, cap: caps.perPerson },
    nextCursor,
  }
}

const changed = (change: FileChange | Refused | null, reply: FastifyReply, gone: { error: string }) => {
  if (!change) return reply.code(404).send(gone)
  if ("refused" in change) return reply.code(409).send({ error: change.refused })
  return reply.send({ ok: true })
}

/** A search inside one folder names the path to it, from whichever section can show that folder */
async function searchTrail(v: FileViewer, query: { projectId?: string; folderId?: string }) {
  if (!query.folderId) return []
  const at = (section: BrowseOptions["section"]): BrowseOptions => ({
    section,
    projectId: query.projectId ?? null,
    folderId: query.folderId ?? null,
    sort: "name",
    dir: "asc",
    cursor: null,
  })
  if (query.projectId) return folderTrail(v, at("project"))
  const mine = await folderTrail(v, at("mine"))
  return mine.length ? mine : folderTrail(v, at("shared"))
}

async function fileBrowserRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.get("/browse", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = parseQuery(fileBrowseQuerySchema, request.query, reply)
    if (!query) return
    const v = viewerFor(request)
    const cursor = query.cursor ? decodeCursor(query.cursor, query.sort) : null
    if (query.cursor && !cursor) return reply.code(400).send({ error: "Invalid cursor" })
    const hasFolders = query.section !== "recent" && query.section !== "trash"
    const options: BrowseOptions = {
      section: query.section,
      projectId: query.section === "project" ? (query.projectId ?? null) : null,
      folderId: hasFolders ? (query.folderId ?? null) : null,
      sort: query.sort,
      dir: query.dir ?? (query.sort === "name" ? "asc" : "desc"),
      cursor,
    }
    const access = options.projectId ? await projectReadAccess(v.userId, v.organizationId, options.projectId) : null
    if (options.projectId && !access) return reply.code(404).send({ error: "Project not found" })
    const trail = await folderTrail(v, options)
    if (options.folderId && trail.length === 0) return reply.code(404).send(FOLDER_GONE)
    const [{ rows, nextCursor }, folders] = await Promise.all([
      listFiles(v, options),
      cursor ? Promise.resolve([]) : listFolders(v, options),
    ])
    if (access?.role === ADMIN_VIEWER) {
      return reply.send({ ...(await listReply(v, asProjectViewer(rows), asProjectViewer(folders), nextCursor)), trail })
    }
    return reply.send({ ...(await listReply(v, rows, folders, nextCursor)), trail })
  })

  fastify.get("/search", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = parseQuery(fileSearchQuerySchema, request.query, reply)
    if (!query) return
    const v = viewerFor(request)
    if (query.projectId && !(await projectAccess(v.userId, v.organizationId, query.projectId))) {
      return reply.code(404).send({ error: "Project not found" })
    }
    const filtered = query.type || query.owner || query.after || query.before
    // Folders and files share one budget, folders first, and a folder only ever matches a name
    const folders = filtered || !query.q ? [] : await searchFolders(v, query.q, query)
    const files = await searchFiles(v, query, SEARCH_LIMIT - folders.length)
    return reply.send({ ...(await listReply(v, files, folders, null)), trail: await searchTrail(v, query) })
  })

  fastify.post("/folders", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(folderCreateBodySchema, request.body, reply)
    if (!body) return
    const v = viewerFor(request)
    const place = await resolvePlace(v, body.projectId ?? null, body.parentId ?? null)
    if (!place) return reply.code(404).send(FOLDER_GONE)
    if (place === "read-only") return reply.code(403).send(READ_ONLY)
    const now = new Date().toISOString()
    const [folder] = await db
      .insert(fileFolders)
      .values({
        name: body.name,
        color: body.color ?? null,
        icon: body.icon ?? null,
        parentFolderId: place.folderId,
        projectId: place.projectId,
        organizationId: v.organizationId,
        createdBy: v.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: fileFolders.id })
    const loaded = await folderFacts(folder.id, v, db)
    return reply.code(201).send(loaded ? loadedFolderDto(loaded) : { id: folder.id })
  })

  fastify.patch("/folders/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const body = parseBody(folderPatchBodySchema, request.body, reply)
    if (!body) return
    const v = viewerFor(request)
    const loaded = await folderFacts(params.id, v, db)
    if (!loaded || !can("view", loaded.facts, loaded.viewer)) return reply.code(404).send(FOLDER_GONE)
    const renames = body.name !== undefined || body.color !== undefined || body.icon !== undefined
    if (renames && !can("rename", loaded.facts, loaded.viewer)) return reply.code(403).send(NOT_YOURS)
    if (body.parentId !== undefined && !can("move", loaded.facts, loaded.viewer)) return reply.code(403).send(NOT_YOURS)

    const changes: Partial<typeof fileFolders.$inferInsert> = { updatedAt: new Date().toISOString() }
    if (body.name !== undefined) changes.name = body.name
    if (body.color !== undefined) changes.color = body.color
    if (body.icon !== undefined) changes.icon = body.icon
    if (body.parentId !== undefined) changes.parentFolderId = body.parentId
    // Moves in one workspace take turns, so two crossing moves cannot make a cycle between them
    const refusal = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`folder-tree:${v.organizationId}`}, 0))`)
      if (body.parentId) {
        const parent = await placeFolder(v, body.parentId, loaded.folder.projectId, tx)
        if (!parent) return { status: 404, error: FOLDER_GONE.error }
        if ((await folderAncestors(parent.id, v.organizationId, tx)).includes(params.id)) {
          return { status: 400, error: "A folder can't move into itself" }
        }
      }
      await tx
        .update(fileFolders)
        .set(changes)
        .where(and(eq(fileFolders.id, params.id), eq(fileFolders.organizationId, v.organizationId)))
      return null
    })
    if (refusal) return reply.code(refusal.status).send({ error: refusal.error })
    const updated = await folderFacts(params.id, v, db)
    return reply.send(updated ? loadedFolderDto(updated) : { id: params.id })
  })

  fastify.delete("/folders/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const v = viewerFor(request)
    const change = await trashFolder(params.id, v, { via: viaOf(request) })
    return change ? reply.send({ ok: true }) : refusedChange("folder", params.id, v, reply)
  })

  fastify.post("/folders/:id/restore", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    return changed(await restoreFolder(params.id, viewerFor(request)), reply, FOLDER_GONE)
  })

  // A trashed folder goes for good with everything its deletion took
  fastify.delete("/folders/:id/forever", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const v = viewerFor(request)
    const loaded = await folderFacts(params.id, v, db)
    const projectAdmin = !loaded?.folder.projectId || loaded.viewer.projectRole === "admin"
    if (!loaded || loaded.folder.trashRoot !== params.id || !projectAdmin || !can("purge", loaded.facts, loaded.viewer)) {
      return reply.code(404).send(FOLDER_GONE)
    }
    const files = await db
      .select({ id: fileAttachments.id })
      .from(fileAttachments)
      .where(and(eq(fileAttachments.trashRoot, params.id), eq(fileAttachments.organizationId, v.organizationId)))
    // Each purge stands alone and only takes what is still in this Trash entry, so a restore meanwhile keeps it all
    for (const file of files) {
      await purgeFile(file.id, { expect: "trashed", trashRoot: params.id, organizationId: v.organizationId })
    }
    const gone = await db
      .delete(fileFolders)
      .where(and(eq(fileFolders.trashRoot, params.id), isNotNull(fileFolders.deletedAt), eq(fileFolders.organizationId, v.organizationId)))
      .returning({ id: fileFolders.id })
    if (gone.length > 0) {
      await db
        .update(fileFolders)
        .set({ parentFolderId: null })
        .where(
          and(
            inArray(
              fileFolders.parentFolderId,
              gone.map((folder) => folder.id),
            ),
            eq(fileFolders.organizationId, v.organizationId),
          ),
        )
    }
    return reply.send({ ok: true })
  })

  fastify.patch("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const body = parseBody(filePatchBodySchema, request.body, reply)
    if (!body) return
    const v = viewerFor(request)
    const loaded = await loadFileFacts(params.id, v)
    if (!loaded || !can("view", loaded.facts, loaded.viewer)) return reply.code(404).send(FILE_GONE)
    const allowed = (action: "rename" | "move" | "editAlt") => can(action, loaded.facts, loaded.viewer)
    if (
      (body.name !== undefined && !allowed("rename")) ||
      (body.folderId !== undefined && !allowed("move")) ||
      (body.altText !== undefined && !allowed("editAlt"))
    ) {
      return reply.code(403).send(NOT_YOURS)
    }
    if (body.folderId !== undefined && loaded.file.isDraft) {
      return reply.code(400).send({ error: "Post this file before you move it" })
    }
    if (body.folderId && !(await placeFolder(v, body.folderId, loaded.file.projectId))) {
      return reply.code(404).send(FOLDER_GONE)
    }
    const changes: Partial<typeof fileAttachments.$inferInsert> = { updatedAt: new Date().toISOString() }
    if (body.name !== undefined) changes.fileName = body.name
    if (body.name !== undefined && loaded.file.uploadedBy === v.userId) changes.nameCopied = false
    if (body.folderId !== undefined) changes.folderId = body.folderId
    if (body.altText !== undefined) changes.altText = body.altText || null
    await db
      .update(fileAttachments)
      .set(changes)
      .where(and(eq(fileAttachments.id, params.id), eq(fileAttachments.organizationId, v.organizationId)))
    const updated = await loadFileFacts(params.id, v)
    return reply.send(updated ? await loadedFileDto(updated) : { id: params.id })
  })

  fastify.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const v = viewerFor(request)
    const change = await trashFile(params.id, v, { via: viaOf(request) })
    return change ? reply.send({ ok: true }) : refusedChange("file", params.id, v, reply)
  })

  fastify.post("/:id/restore", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    return changed(await restoreFile(params.id, viewerFor(request)), reply, FILE_GONE)
  })

  // From Trash, and only an item Trash lists, so a file trashed with its folder goes with the folder. Or the owner's own draft
  fastify.delete("/:id/forever", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const v = viewerFor(request)
    const loaded = await loadFileFacts(params.id, v)
    const root = loaded && (!loaded.file.trashRoot || loaded.file.trashRoot === params.id)
    const reachable = loaded && (loaded.file.deletedAt ? root : loaded.file.isDraft)
    if (!loaded || !reachable || !can("purge", loaded.facts, loaded.viewer)) {
      return reply.code(404).send(FILE_GONE)
    }
    // Decided on a trashed file or on the caller's own draft, and purged only if it still is one
    const guard = loaded.file.deletedAt
      ? ({ expect: "trashed", ownRoot: true, organizationId: v.organizationId } as const)
      : ({ expect: "draft", ownerId: v.userId, organizationId: v.organizationId } as const)
    if (!(await purgeFile(params.id, guard))) return reply.code(404).send(FILE_GONE)
    return reply.send({ ok: true })
  })

  // Save to my files: a real copy owned by the saver, which counts toward their storage
  fastify.post("/:id/copy", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const v = viewerFor(request)
    const loaded = await loadFileFacts(params.id, v)
    if (!loaded || loaded.file.deletedAt || !can("view", loaded.facts, loaded.viewer)) return reply.code(404).send(FILE_GONE)
    if (!can("copy", loaded.facts, loaded.viewer)) return reply.code(400).send({ error: "This file is already yours" })
    const source = loaded.file
    // A paper or board copies its current state and preview, without comments or history, and has no stored object.
    // The images it shows are copied too, since an image opens only inside its own doc
    const doc = isDoc(source) ? await docCopy(source, v.organizationId) : null
    if (isDoc(source) && !doc) return reply.code(404).send(FILE_GONE)
    const state = doc?.state ?? null
    const size = state ? state.length : source.fileSize
    const images = (doc?.images ?? []).map((image) => ({
      ...image,
      key: objectKey("attachment", v.organizationId, v.userId, image.from.fileName),
    }))
    const imageBytes = images.reduce((sum, image) => sum + image.from.fileSize, 0)
    const withImages = (usage: { person: number; workspace: number }) => ({
      person: usage.person + imageBytes,
      workspace: usage.workspace + imageBytes,
    })

    const { caps, usage } = await capsAndUsage(v)
    const early = capCheck(size, withImages(usage), caps, false)
    if (!early.ok) return reply.code(413).send({ error: early.reason, limit: early.limit })

    const id = randomUUID()
    const key = state ? docPath(id) : objectKey("attachment", v.organizationId, v.userId, source.fileName)
    const objects = state ? images.map((image) => ({ from: image.from.filePath, to: image.key })) : [{ from: source.filePath, to: key }]
    const copied: string[] = []
    const dropObject = () =>
      Promise.all(copied.map((made) => deleteObject(made).catch(() => dropStoredObjects(db, [made])))).catch((error) =>
        request.log.error({ err: error, keys: copied }, "A failed copy left its stored objects behind"),
      )
    try {
      for (const { from, to } of objects) {
        await copyObject(from, to)
        copied.push(to)
      }
    } catch (error) {
      await dropObject()
      const refusal = storageRefusal(error)
      if (refusal) return reply.code(refusal.status).send({ error: refusal.error })
      throw error
    }

    let saved: { id: string } | CapRefusal
    try {
      saved = await db.transaction(async (tx) => {
        await lockUsage(tx, v.organizationId)
        const verdict = capCheck(size, withImages((await capsAndUsage(v, tx)).usage), caps, false)
        if (!verdict.ok) return verdict
        const [row] = await tx
          .insert(fileAttachments)
          .values({
            id,
            fileName: source.fileName,
            filePath: key,
            fileSize: size,
            mimeType: source.mimeType,
            docType: source.docType,
            altText: source.altText,
            nameCopied: true,
            uploadedBy: v.userId,
            organizationId: v.organizationId,
          })
          .returning({ id: fileAttachments.id })
        if (state) {
          await tx.insert(docContents).values({ fileId: id, organizationId: v.organizationId, state, thumbnail: doc?.thumbnail ?? null })
          // Marked as a copy, so its text never passes as the copier's own and the original's authors stay unnamed
          await tx.insert(docVersions).values({ organizationId: v.organizationId, fileId: id, state, editorIds: [v.userId], copied: true })
        }
        if (images.length > 0) {
          await tx.insert(fileAttachments).values(
            images.map((image) => ({
              id: image.id,
              fileName: image.from.fileName,
              filePath: image.key,
              fileSize: image.from.fileSize,
              mimeType: image.from.mimeType,
              altText: image.from.altText,
              kind: "docimage",
              docFileId: id,
              uploadedBy: v.userId,
              organizationId: v.organizationId,
            })),
          )
        }
        return row
      })
    } catch (error) {
      await dropObject()
      throw error
    }
    if ("reason" in saved) {
      await dropObject()
      return reply.code(413).send({ error: saved.reason, limit: saved.limit })
    }
    // The copy is committed, so from here its object stays whatever happens
    const copy = await loadFileFacts(saved.id, v)
    return reply.code(201).send(copy ? await loadedFileDto(copy) : { id: saved.id })
  })
}

export default fileBrowserRoutes
