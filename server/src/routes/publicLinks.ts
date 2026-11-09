import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { and, asc, eq, gt, isNull, sql, type SQL } from "drizzle-orm"
import { db, fileAttachments, fileFolders, fileShareLinks, users } from "../db"
import { decodeCursor, encodeCursor, type Cursor } from "../services/fileQueries"
import { sendDownload } from "../services/storage"
import { linkState } from "../utils/fileLinks"
import { publicDownloadParamsSchema, publicLinkParamsSchema, publicLinkQuerySchema } from "../validation/schemas"

const publicRateLimit = { max: 30, timeWindow: "1 minute" as const }
const GONE = { error: "Link not found" }
const OPAQUE = "application/octet-stream"
const MAX_FOLDER_DEPTH = 64
const PAGE = 200

type LinkRow = typeof fileShareLinks.$inferSelect
type FileRow = typeof fileAttachments.$inferSelect
type FolderRow = typeof fileFolders.$inferSelect

/** What a folder link reaches: its folder, and whose items count inside it */
type FolderReach = {
  root: FolderRow
  organizationId: string
  files: SQL | undefined
  folders: SQL | undefined
  /** The same rule for the raw folder walk, against `f` */
  chain: SQL
}

type Resolved = { link: LinkRow; organizationId: string } & ({ kind: "file"; file: FileRow } | { kind: "folder"; reach: FolderReach })

/** A user's removal ends the links the user owns, and a project item's links end with their creator's removal */
async function removedAt(userId: string): Promise<string | null> {
  const [row] = await db.select({ removedAt: users.removedAt }).from(users).where(eq(users.id, userId))
  return row?.removedAt ?? null
}

/** The active link the token names, with what it shares. Null for anything else */
async function resolveLink(token: string, now: Date): Promise<Resolved | null> {
  // tenancy: a token names one link, and every query after this one is keyed by that link's organization_id
  const [link] = await db.select().from(fileShareLinks).where(eq(fileShareLinks.token, token)).limit(1)
  const organizationId = link?.organizationId
  if (!link || !organizationId) return null

  if (link.fileId) {
    const [file] = await db
      .select()
      .from(fileAttachments)
      .where(and(eq(fileAttachments.id, link.fileId), eq(fileAttachments.organizationId, organizationId)))
    // Papers and boards have no public viewer, so an outside link never reaches one
    const usable = file && file.kind === "file" && !file.docType && !file.isDraft ? file : null
    const holder = usable ? await removedAt(usable.projectId ? link.createdBy : usable.uploadedBy) : null
    const state = linkState(link, usable ? { deletedAt: usable.deletedAt, ownerRemovedAt: holder } : null, now)
    return state === "active" && usable ? { link, organizationId, kind: "file", file: usable } : null
  }

  if (!link.folderId) return null
  const [root] = await db
    .select()
    .from(fileFolders)
    .where(and(eq(fileFolders.id, link.folderId), eq(fileFolders.organizationId, organizationId)))
  const holder = root ? await removedAt(root.projectId ? link.createdBy : root.createdBy) : null
  const state = linkState(link, root ? { deletedAt: root.deletedAt, ownerRemovedAt: holder } : null, now)
  if (state !== "active" || !root) return null
  // A personal tree holds only its owner's items, and a project tree only the project's
  const reach: FolderReach = root.projectId
    ? {
        root,
        organizationId,
        files: eq(fileAttachments.projectId, root.projectId),
        folders: eq(fileFolders.projectId, root.projectId),
        chain: sql`f.project_id = ${root.projectId}::uuid`,
      }
    : {
        root,
        organizationId,
        files: and(isNull(fileAttachments.projectId), eq(fileAttachments.uploadedBy, root.createdBy)),
        folders: and(isNull(fileFolders.projectId), eq(fileFolders.createdBy, root.createdBy)),
        chain: sql`f.project_id is null and f.created_by = ${root.createdBy}::uuid`,
      }
  return { link, organizationId, kind: "folder", reach }
}

/** Whether a folder sits in the linked tree, with every folder from it up to the root live and in reach */
async function inTree(reach: FolderReach, folderId: string): Promise<boolean> {
  if (folderId === reach.root.id) return true
  const O = sql`${reach.organizationId}::uuid`
  const [row] = await db.execute<{ reached: boolean; live: boolean }>(sql`
    with recursive chain(id, parent, live, depth) as (
      select f.id, f.parent_folder_id, (f.deleted_at is null and ${reach.chain}), 0
      from file_folders f where f.id = ${folderId}::uuid and f.organization_id = ${O}
      union all
      select f.id, f.parent_folder_id, (f.deleted_at is null and ${reach.chain}), c.depth + 1
      from file_folders f join chain c on f.id = c.parent
      where f.organization_id = ${O} and c.id <> ${reach.root.id}::uuid and c.depth < ${MAX_FOLDER_DEPTH}::int
    )
    select coalesce(bool_or(id = ${reach.root.id}::uuid), false) as reached, coalesce(bool_and(live), false) as live from chain`)
  return !!row?.reached && !!row.live
}

const liveFile = () =>
  and(
    isNull(fileAttachments.deletedAt),
    eq(fileAttachments.isDraft, false),
    eq(fileAttachments.kind, "file"),
    isNull(fileAttachments.docType),
  )

/** Malformed input answers like a missing link */
function parsed<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T | null {
  const result = schema.safeParse(value)
  return result.success ? result.data : null
}

/** A page cursor. Folders come first, then files, each by name, and `d` or `f` says which list it continues */
type PageCursor = { phase: "d" | "f"; after: Cursor }

function readCursor(value: string): PageCursor | null {
  const phase = value[0]
  if (phase !== "d" && phase !== "f") return null
  const after = decodeCursor(value.slice(1), "name")
  return after ? { phase, after } : null
}

const pageCursor = (phase: "d" | "f", key: string, id: string) => `${phase}${encodeCursor([key, id])}`

const fileItem = (file: { id: string; fileName: string; fileSize: number; mimeType: string | null }) => ({
  id: file.id,
  name: file.fileName,
  size: file.fileSize,
  mimeType: file.mimeType || OPAQUE,
})

async function publicLinkRoutes(fastify: FastifyInstance) {
  fastify.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store")
  })

  fastify.get("/:token", { config: { rateLimit: publicRateLimit } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parsed(publicLinkParamsSchema, request.params)
    const query = parsed(publicLinkQuerySchema, request.query)
    if (!params || !query) return reply.code(404).send(GONE)
    const cursor = query.cursor ? readCursor(query.cursor) : null
    if (query.cursor && !cursor) return reply.code(404).send(GONE)
    const resolved = await resolveLink(params.token, new Date())
    if (!resolved) return reply.code(404).send(GONE)

    if (resolved.kind === "file") {
      if (query.folderId || cursor) return reply.code(404).send(GONE)
      const { file } = resolved
      return reply.send({ kind: "file", name: file.fileName, files: [fileItem(file)], folders: [], nextCursor: null })
    }

    const { reach } = resolved
    const folderId = query.folderId ?? reach.root.id
    if (!(await inTree(reach, folderId))) return reply.code(404).send(GONE)
    const [shown] =
      folderId === reach.root.id
        ? [reach.root]
        : await db
            .select()
            .from(fileFolders)
            .where(and(eq(fileFolders.id, folderId), eq(fileFolders.organizationId, reach.organizationId)))
    if (!shown) return reply.code(404).send(GONE)

    const folderKey = sql<string>`lower(${fileFolders.name})`
    const fileKey = sql<string>`lower(${fileAttachments.fileName})`
    const after = (key: SQL, id: SQL, at: Cursor | undefined) =>
      at ? gt(sql`(${key}, ${id})`, sql`(${at[0]}::text, ${at[1]}::uuid)`) : undefined

    // One more row than a page says whether another page follows
    const folders =
      cursor?.phase === "f"
        ? []
        : await db
            .select({ id: fileFolders.id, name: fileFolders.name, key: folderKey })
            .from(fileFolders)
            .where(
              and(
                eq(fileFolders.organizationId, reach.organizationId),
                eq(fileFolders.parentFolderId, folderId),
                isNull(fileFolders.deletedAt),
                reach.folders,
                after(folderKey, sql`${fileFolders.id}`, cursor?.after),
              ),
            )
            .orderBy(asc(folderKey), asc(fileFolders.id))
            .limit(PAGE + 1)
    const pageFolders = folders.slice(0, PAGE)
    const lastFolder = pageFolders[pageFolders.length - 1]
    const folderItems = pageFolders.map(({ id, name }) => ({ id, name }))
    if (folders.length > PAGE) {
      return reply.send({
        kind: "folder",
        name: shown.name,
        files: [],
        folders: folderItems,
        nextCursor: pageCursor("d", lastFolder.key, lastFolder.id),
      })
    }

    const room = PAGE - pageFolders.length
    const files = await db
      .select({
        id: fileAttachments.id,
        fileName: fileAttachments.fileName,
        fileSize: fileAttachments.fileSize,
        mimeType: fileAttachments.mimeType,
        key: fileKey,
      })
      .from(fileAttachments)
      .where(
        and(
          eq(fileAttachments.organizationId, reach.organizationId),
          eq(fileAttachments.folderId, folderId),
          liveFile(),
          reach.files,
          after(fileKey, sql`${fileAttachments.id}`, cursor?.phase === "f" ? cursor.after : undefined),
        ),
      )
      .orderBy(asc(fileKey), asc(fileAttachments.id))
      .limit(room + 1)
    const pageFiles = files.slice(0, room)
    const lastFile = pageFiles[pageFiles.length - 1]
    let nextCursor: string | null = null
    if (files.length > room) {
      // A page filled by folders alone continues with the first file
      nextCursor = lastFile ? pageCursor("f", lastFile.key, lastFile.id) : pageCursor("d", lastFolder.key, lastFolder.id)
    }
    return reply.send({ kind: "folder", name: shown.name, files: pageFiles.map(fileItem), folders: folderItems, nextCursor })
  })

  fastify.get(
    "/:token/files/:fileId/download",
    { config: { rateLimit: publicRateLimit } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = parsed(publicDownloadParamsSchema, request.params)
      if (!params) return reply.code(404).send(GONE)
      const resolved = await resolveLink(params.token, new Date())
      if (!resolved) return reply.code(404).send(GONE)

      let file: FileRow | null = null
      if (resolved.kind === "file") {
        file = resolved.file.id === params.fileId ? resolved.file : null
      } else {
        const { reach } = resolved
        const [found] = await db
          .select()
          .from(fileAttachments)
          .where(
            and(eq(fileAttachments.id, params.fileId), eq(fileAttachments.organizationId, reach.organizationId), liveFile(), reach.files),
          )
        file = found?.folderId && (await inTree(reach, found.folderId)) ? found : null
      }
      if (!file) return reply.code(404).send(GONE)

      const { link, organizationId } = resolved
      return sendDownload(reply, file, request.log, () =>
        db
          .update(fileShareLinks)
          .set({ downloadCount: sql`${fileShareLinks.downloadCount} + 1` })
          .where(and(eq(fileShareLinks.id, link.id), eq(fileShareLinks.organizationId, organizationId))),
      )
    },
  )
}

export default publicLinkRoutes
