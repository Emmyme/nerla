import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm"
import { db, fileAttachments, fileGrants, fileShareLinks, users } from "../db"
import { authMiddleware } from "../middleware/auth"
import { closeDocConnections } from "../services/collab"
import { docLevelFor } from "../services/docs"
import { capsAndUsage, fileKind } from "../services/fileQueries"
import { emitFileChanged, folderFacts, loadFileFacts, purgeFile, type FileViewer } from "../services/files"
import { notify } from "../services/notifications"
import { membersOf, orgAdminMiddleware, orgMiddleware, viewerFor } from "../services/tenancy"
import { CLIENT_URL } from "../utils/clientUrl"
import { capLevel, type DocLevel } from "../utils/docAccess"
import { can, type FileAction, type FileFacts, type ViewerFacts } from "../utils/fileAccess"
import { expiryDate, newLinkToken } from "../utils/fileLinks"
import { presenceName } from "../utils/presence"
import { parseBody, parseParams } from "../validation/helpers"
import {
  adminUsageParamsSchema,
  fileGrantBodySchema,
  fileGrantParamsSchema,
  fileIdParamsSchema,
  fileLinkBodySchema,
  fileLinkIdParamsSchema,
} from "../validation/schemas"

type ItemKind = "file" | "folder"
/** `docType` is set for a paper or board */
type Loaded = { facts: FileFacts; viewer: ViewerFacts; docType: string | null }

const GONE: Record<ItemKind, { error: string }> = {
  file: { error: "File not found" },
  folder: { error: "Folder not found" },
}
const LINK_GONE = { error: "Link not found" }
const NO_DOC_LINKS = { error: "Papers and boards can't have outside links" }

/** The file or folder when the caller may see it. A draft is not shareable yet */
async function itemOf(kind: ItemKind, id: string, v: FileViewer): Promise<Loaded | null> {
  if (kind === "file") {
    const loaded = await loadFileFacts(id, v)
    return loaded && !loaded.file.isDraft && can("view", loaded.facts, loaded.viewer) ? { ...loaded, docType: loaded.file.docType } : null
  }
  const loaded = await folderFacts(id, v, db)
  return loaded && can("view", loaded.facts, loaded.viewer) ? { ...loaded, docType: null } : null
}

/** The item when the caller may do `action` on it, or the reply already sent */
async function permitted(
  kind: ItemKind,
  id: string,
  action: FileAction,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Loaded | null> {
  const loaded = await itemOf(kind, id, viewerFor(request))
  if (!loaded) {
    reply.code(404).send(GONE[kind])
    return null
  }
  if (!can(action, loaded.facts, loaded.viewer)) {
    const error = action === "share" ? "Only your own files can be shared" : "You can't make a link for this"
    reply.code(403).send({ error })
    return null
  }
  return loaded
}

const grantOn = (kind: ItemKind, id: string) => (kind === "file" ? eq(fileGrants.fileId, id) : eq(fileGrants.folderId, id))
const linkOn = (kind: ItemKind, id: string) => (kind === "file" ? eq(fileShareLinks.fileId, id) : eq(fileShareLinks.folderId, id))

async function grantList(kind: ItemKind, id: string, organizationId: string) {
  const rows = await db
    .select({
      userId: fileGrants.userId,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarUrl: users.avatarUrl,
      level: fileGrants.level,
      createdAt: fileGrants.createdAt,
    })
    .from(fileGrants)
    .innerJoin(users, eq(users.id, fileGrants.userId))
    .where(and(grantOn(kind, id), eq(fileGrants.organizationId, organizationId)))
    .orderBy(asc(fileGrants.createdAt), asc(fileGrants.id))
  const seen = new Set<string>()
  return rows
    .filter((row) => !seen.has(row.userId) && seen.add(row.userId))
    .map((row) => ({
      userId: row.userId,
      name: presenceName(row.firstName, row.lastName),
      avatarUrl: row.avatarUrl,
      level: row.level as DocLevel,
      createdAt: row.createdAt,
    }))
}

const linkUrl = (token: string) => `${CLIENT_URL}/s/${token}`

const nowUtc = () => new Date().toISOString()

const activeLink = () => and(isNull(fileShareLinks.revokedAt), or(isNull(fileShareLinks.expiresAt), gt(fileShareLinks.expiresAt, nowUtc())))

function linkDto(row: typeof fileShareLinks.$inferSelect) {
  return {
    id: row.id,
    url: linkUrl(row.token),
    expiresAt: row.expiresAt,
    downloadCount: row.downloadCount,
    createdAt: row.createdAt,
  }
}

/** Grant and link routes for files at `base` = "", and for folders at "/folders" */
function itemRoutes(fastify: FastifyInstance, kind: ItemKind, base: string) {
  fastify.get(`${base}/:id/grants`, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    if (!(await permitted(kind, params.id, "share", request, reply))) return
    return reply.send({ grants: await grantList(kind, params.id, viewerFor(request).organizationId) })
  })

  fastify.post(`${base}/:id/grants`, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const body = parseBody(fileGrantBodySchema, request.body, reply)
    if (!body) return
    const loaded = await permitted(kind, params.id, "share", request, reply)
    if (!loaded) return
    if (body.level && body.level !== "view" && !loaded.docType) {
      return reply.code(400).send({ error: "Only papers and boards can be shared above view" })
    }
    const v = viewerFor(request)
    // A user never grants more than their own level
    const own = loaded.docType ? (await docLevelFor(params.id, v)).level : "view"
    if (!own) return reply.code(404).send(GONE[kind])
    const level = body.level ? capLevel(body.level, own) : null
    const wanted = [...new Set(body.userIds)].filter((userId) => userId !== v.userId)
    const fileId = kind === "file" ? params.id : null
    const folderId = kind === "folder" ? params.id : null
    const column = kind === "file" ? sql`g.file_id` : sql`g.folder_id`
    const outcome = await db.transaction(async (tx) => {
      // Two shares of one item take turns, so the second finds the first grant
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`file-grant:${kind}:${params.id}`}, 0))`)
      const members = await membersOf(v.organizationId, wanted, tx)
      if (wanted.some((userId) => !members.has(userId))) return null
      const fresh: string[] = []
      const changed: string[] = []
      for (const userId of wanted) {
        const match = sql`${column} = ${params.id}::uuid and g.user_id = ${userId}::uuid and g.organization_id = ${v.organizationId}::uuid`
        const existing = await tx.execute<{ level: string }>(sql`select g.level from file_grants g where ${match}`)
        if (existing.length > 0) {
          // Sharing again with a level changes the grantee's level, and without one leaves it
          if (level && existing.some((row) => row.level !== level)) {
            await tx.execute(sql`update file_grants g set level = ${level} where ${match}`)
            changed.push(userId)
          }
          continue
        }
        await tx.execute(sql`
          insert into file_grants (file_id, folder_id, user_id, granted_by, level, organization_id)
          values (${fileId}::uuid, ${folderId}::uuid, ${userId}::uuid, ${v.userId}::uuid, ${level ?? "view"}, ${v.organizationId}::uuid)`)
        fresh.push(userId)
      }
      return { fresh, changed }
    })
    if (!outcome) return reply.code(400).send({ error: "You can only share with people in this workspace" })
    // A live connection keeps the level it opened with, so a changed one reconnects to get the new one
    if (fileId) for (const userId of outcome.changed) closeDocConnections({ fileId, userId })
    if (loaded.docType && fileId && outcome.fresh.length > 0) {
      void notify(v.organizationId, { type: "doc_shared", actorId: v.userId, fileId, userIds: outcome.fresh })
    }
    return reply.send({ grants: await grantList(kind, params.id, v.organizationId) })
  })

  fastify.delete(`${base}/:id/grants/:userId`, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileGrantParamsSchema, request.params, reply)
    if (!params) return
    if (!(await permitted(kind, params.id, "share", request, reply))) return
    await db
      .delete(fileGrants)
      .where(
        and(
          grantOn(kind, params.id),
          eq(fileGrants.userId, params.userId),
          eq(fileGrants.organizationId, viewerFor(request).organizationId),
        ),
      )
    // A folder grant reaches every doc under it, so all of the user's live docs check again
    closeDocConnections(kind === "file" ? { fileId: params.id, userId: params.userId } : { userId: params.userId })
    return reply.send({ ok: true })
  })

  fastify.get(`${base}/:id/links`, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const v = viewerFor(request)
    const loaded = await itemOf(kind, params.id, v)
    if (!loaded) return reply.code(404).send(GONE[kind])
    // A workspace admin who can see the item may turn its links off, but gets no url to copy
    const linker = can("link", loaded.facts, loaded.viewer)
    if (!linker && !v.isOrgAdmin) return reply.code(403).send({ error: "You can't make a link for this" })
    const rows = await db
      .select()
      .from(fileShareLinks)
      .where(and(linkOn(kind, params.id), eq(fileShareLinks.organizationId, v.organizationId), activeLink()))
      .orderBy(desc(fileShareLinks.createdAt), desc(fileShareLinks.id))
    return reply.send({
      links: rows.map((row) => {
        const { url, ...rest } = linkDto(row)
        return linker ? { url, ...rest } : rest
      }),
    })
  })

  fastify.post(`${base}/:id/links`, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const body = parseBody(fileLinkBodySchema, request.body, reply)
    if (request.body !== undefined && !body) return
    const loaded = await permitted(kind, params.id, "link", request, reply)
    if (!loaded) return
    if (loaded.docType) return reply.code(409).send(NO_DOC_LINKS)
    const v = viewerFor(request)
    const [row] = await db
      .insert(fileShareLinks)
      .values({
        token: newLinkToken(),
        fileId: kind === "file" ? params.id : null,
        folderId: kind === "folder" ? params.id : null,
        createdBy: v.userId,
        organizationId: v.organizationId,
        expiresAt: expiryDate(body?.expiry ?? "7d", new Date()),
      })
      .returning()
    return reply.code(201).send(linkDto(row))
  })
}

/** The creator, the owner, a project admin for a project item, or any workspace admin */
async function mayRevoke(link: typeof fileShareLinks.$inferSelect, v: FileViewer): Promise<boolean> {
  if (link.createdBy === v.userId || v.isOrgAdmin) return true
  const loaded = link.fileId ? await loadFileFacts(link.fileId, v) : link.folderId ? await folderFacts(link.folderId, v, db) : null
  if (!loaded) return false
  const { facts, viewer } = loaded
  return facts.projectId ? viewer.projectRole === "admin" : facts.ownerId === v.userId
}

async function fileSharingRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  itemRoutes(fastify, "file", "")
  itemRoutes(fastify, "folder", "/folders")

  fastify.delete("/links/:linkId", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileLinkIdParamsSchema, request.params, reply)
    if (!params) return
    const v = viewerFor(request)
    const [link] = await db
      .select()
      .from(fileShareLinks)
      .where(and(eq(fileShareLinks.id, params.linkId), eq(fileShareLinks.organizationId, v.organizationId)))
    if (!link || !(await mayRevoke(link, v))) return reply.code(404).send(LINK_GONE)
    await db
      .update(fileShareLinks)
      .set({ revokedAt: nowUtc() })
      .where(and(eq(fileShareLinks.id, link.id), eq(fileShareLinks.organizationId, v.organizationId), isNull(fileShareLinks.revokedAt)))
    return reply.send({ ok: true })
  })

  fastify.get("/admin/usage", { preHandler: orgAdminMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    const v = viewerFor(request)
    const O = sql`${v.organizationId}::uuid`
    const [rows, { caps, usage }] = await Promise.all([
      db.execute<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string
        avatar_url: string | null
        used: number
        file_count: number
        link_count: number
      }>(sql`
        select u.id, u.first_name, u.last_name, u.email, u.avatar_url,
          coalesce(fs.used, 0)::float8 as used, coalesce(fs.files, 0)::int as file_count, coalesce(ls.links, 0)::int as link_count
        from users u
        left join lateral (
          select sum(a.file_size) as used, count(*) as files from file_attachments a
          where a.organization_id = ${O} and a.uploaded_by = u.id and a.project_id is null and a.kind <> 'avatar') fs on true
        left join lateral (
          select count(*) as links from file_share_links s
          where s.organization_id = ${O} and s.created_by = u.id and s.revoked_at is null
            and (s.expires_at is null or s.expires_at > (now() at time zone 'utc'))) ls on true
        where u.id in (select m.user_id from organization_members m where m.organization_id = ${O})
        order by used desc, u.id`),
      capsAndUsage(v),
    ])
    return reply.send({
      members: rows.map((row) => ({
        userId: row.id,
        name: presenceName(row.first_name, row.last_name),
        email: row.email,
        avatarUrl: row.avatar_url,
        used: row.used,
        fileCount: row.file_count,
        linkCount: row.link_count,
      })),
      total: usage.workspace,
      caps: { perPerson: caps.perPerson, total: caps.total, maxFile: caps.maxFile },
    })
  })

  // Sizes and types only. A name shows only for what the user already shared outside
  fastify.get("/admin/usage/:userId", { preHandler: orgAdminMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(adminUsageParamsSchema, request.params, reply)
    if (!params) return
    const v = viewerFor(request)
    const O = sql`${v.organizationId}::uuid`
    const [largest, links] = await Promise.all([
      db
        .select({
          id: fileAttachments.id,
          mimeType: fileAttachments.mimeType,
          size: fileAttachments.fileSize,
          updatedAt: fileAttachments.updatedAt,
        })
        .from(fileAttachments)
        .where(
          and(
            eq(fileAttachments.organizationId, v.organizationId),
            eq(fileAttachments.uploadedBy, params.userId),
            isNull(fileAttachments.projectId),
            eq(fileAttachments.kind, "file"),
            eq(fileAttachments.isDraft, false),
          ),
        )
        .orderBy(desc(fileAttachments.fileSize), desc(fileAttachments.id))
        .limit(20),
      db.execute<{ id: string; kind: ItemKind; name: string; expires_at: string | null; download_count: number }>(sql`
        select s.id, case when s.file_id is not null then 'file' else 'folder' end as kind,
          coalesce(f.file_name, ff.name) as name, s.expires_at::text as expires_at, s.download_count
        from file_share_links s
        left join file_attachments f on f.id = s.file_id and f.organization_id = ${O}
        left join file_folders ff on ff.id = s.folder_id and ff.organization_id = ${O}
        where s.organization_id = ${O} and s.created_by = ${params.userId}::uuid and s.revoked_at is null
          and (s.expires_at is null or s.expires_at > (now() at time zone 'utc'))
          and coalesce(f.id, ff.id) is not null and coalesce(f.deleted_at, ff.deleted_at) is null
        order by s.created_at desc, s.id desc`),
    ])
    return reply.send({
      files: largest.map((file) => ({ id: file.id, kind: fileKind(file.mimeType), size: file.size, updatedAt: file.updatedAt })),
      links: links.map((link) => ({
        id: link.id,
        kind: link.kind,
        name: link.name,
        expiresAt: link.expires_at,
        downloadCount: link.download_count,
      })),
    })
  })

  // Permanent, to free space at once. The chats are told first, since the purge takes the links with it
  fastify.delete("/admin/files/:id", { preHandler: orgAdminMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(fileIdParamsSchema, request.params, reply)
    if (!params) return
    const v = viewerFor(request)
    const loaded = await loadFileFacts(params.id, v)
    if (!loaded || !can("adminDelete", loaded.facts, loaded.viewer)) return reply.code(404).send(GONE.file)
    await emitFileChanged({ fileIds: [params.id], removed: true }, v.organizationId)
    if (!(await purgeFile(params.id, { expect: "any", organizationId: v.organizationId }))) return reply.code(404).send(GONE.file)
    return reply.send({ ok: true })
  })
}

export default fileSharingRoutes
