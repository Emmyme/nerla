import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { authMiddleware } from "../middleware/auth"
import { isMemberOf, orgMiddleware, orgOf } from "../services/tenancy"
import { db, projects, projectMembers, projectPins, groupChats, type Tx } from "../db"
import { eq, and, desc, inArray, sql } from "drizzle-orm"
import { liveProject } from "../utils/trash"
import { randomInt } from "node:crypto"
import { parseBody, parseParams } from "../validation/helpers"
import {
  projectCreateBodySchema,
  projectUpdateBodySchema,
  projectIdParamsSchema,
  projectSlugParamsSchema,
  idParamsSchema,
  projectMemberPostBodySchema,
  projectMemberRolePutBodySchema,
  projectMemberParamsSchema,
} from "../validation/schemas"
import { deriveProjectKey } from "../utils/taskKeys"
import { loadProjectDto, loadProjectDtos } from "../utils/projectDto"
import { ensureProjectChat, syncProjectChatMembers } from "../services/projectChat"
import {
  leaveProject,
  lockProject,
  memberProjectIds,
  memberRowsInOrg,
  projectAccess,
  ADMIN_VIEWER,
  projectReadAccess,
  projectReadAccessBySlug,
  type ProjectAccess,
} from "../services/projectAccess"
import { chatsChanged, groupMemberIds } from "../services/chats"
import { closeDocConnections } from "../services/collab"
import { removesLastAdmin } from "../utils/projectMembership"
import { notify } from "../services/notifications"
import { finishLeaversTimer } from "../services/timeEntries"
import { projectTrashAccess, purgeProject, restoreProject, trashProject } from "../services/projectTrash"
import { viaOf } from "../utils/via"
import { logger } from "../utils/logger"
import { READ_ONLY, toISOStringOrNull } from "./helpers"

const SWATCHES = ["#D5EDB5", "#A8D477", "#FF9CC8", "#FF6FAE", "#BFE3FF", "#7CC2F7", "#DCD0FF", "#B39CFF"]

const KEY_TAKEN_ERROR = "That key is taken. Pick a different one."
const KEY_IN_TRASH_ERROR = "That key belongs to a project in the trash"

/** Says a key's project is in the trash only to a member of it, so a user outside it learns nothing more */
async function keyRefusal(tx: Tx, holder: { id: string; deletedAt: string | null }, userId: string): Promise<string> {
  if (!holder.deletedAt) return KEY_TAKEN_ERROR
  // tenancy: the holder was read within the caller's workspace
  const [member] = await tx
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, holder.id), eq(projectMembers.userId, userId)))
    .limit(1)
  return member ? KEY_IN_TRASH_ERROR : KEY_TAKEN_ERROR
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

const withSuffix = (base: string) => `${base}-${Array.from({ length: 6 }, () => SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)]).join("")}`

const isUniqueViolation = (error: unknown) => {
  const failure = error as { code?: string; cause?: { code?: string } } | null | undefined
  return (failure?.code ?? failure?.cause?.code) === "23505"
}

const LAST_ADMIN_ERROR = "A project needs at least one admin"

const memberDto = (row: typeof projectMembers.$inferSelect) => ({
  id: row.id,
  project_id: row.projectId,
  user_id: row.userId,
  role: row.role,
  created_at: toISOStringOrNull(row.createdAt),
})

/** The project as the caller sees it. A workspace admin outside it reads it with no way into its chat */
async function projectReply(access: ProjectAccess) {
  const dto = await loadProjectDto(access.project)
  const member = access.role !== ADMIN_VIEWER
  return { ...dto, member, chat_id: member ? dto.chat_id : null }
}

async function projectRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.get("/user", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user

    try {
      const member = orgOf(request)

      const [visible, pins] = await Promise.all([
        db.query.projects.findMany({
          where: and(inArray(projects.id, memberProjectIds(user.id, member.organizationId)), liveProject),
          orderBy: [desc(projects.createdAt)],
        }),
        db
          .select({
            projectId: projectPins.projectId,
            pinnedAt: sql<string>`min(${projectPins.createdAt})`,
          })
          .from(projectPins)
          .where(and(eq(projectPins.userId, user.id), eq(projectPins.organizationId, member.organizationId)))
          .groupBy(projectPins.projectId),
      ])

      const pinnedAt = new Map(pins.map((pin) => [pin.projectId, toISOStringOrNull(pin.pinnedAt)]))
      const dtos = await loadProjectDtos(visible)
      return reply.send(
        dtos.map((dto) => ({
          ...dto,
          member: true,
          pinned: pinnedAt.has(dto.id),
          pinned_at: pinnedAt.get(dto.id) ?? null,
        })),
      )
    } catch (error) {
      logger.error("Error fetching user projects:", error)
      return reply.code(500).send({ error: "Failed to fetch projects" })
    }
  })

  /** Every project in the workspace for its admins, marked with whether they are a member. Others get their own */
  fastify.get("/all", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user

    try {
      const { organizationId, role } = orgOf(request)
      const [rows, mine] = await Promise.all([
        db.query.projects.findMany({
          where: and(
            role === "admin"
              ? eq(projects.organizationId, organizationId)
              : inArray(projects.id, memberProjectIds(user.id, organizationId)),
            liveProject,
          ),
          orderBy: [desc(projects.createdAt)],
        }),
        memberProjectIds(user.id, organizationId),
      ])
      const memberOf = new Set(mine.map((row) => row.id))
      const dtos = await loadProjectDtos(rows)
      return reply.send(
        dtos.map((dto) => {
          const member = memberOf.has(dto.id)
          return { ...dto, member, chat_id: member ? dto.chat_id : null }
        }),
      )
    } catch (error) {
      logger.error("Error fetching workspace projects:", error)
      return reply.code(500).send({ error: "Failed to fetch projects" })
    }
  })

  fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const body = parseBody(projectCreateBodySchema, request.body, reply)
    if (!body) return

    try {
      const member = orgOf(request)

      const orgId = member.organizationId
      const created = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"project-key:" + orgId}))`)

        // trash: a project in Trash keeps its key
        const orgProjects = await tx
          .select({ id: projects.id, key: projects.key, color: projects.color, deletedAt: projects.deletedAt })
          .from(projects)
          .where(eq(projects.organizationId, orgId))
        const taken = new Set(orgProjects.map((p) => p.key).filter((k): k is string => !!k))

        const holder = body.key ? orgProjects.find((p) => p.key === body.key) : undefined
        if (holder) return { refused: await keyRefusal(tx, holder, user.id) }
        const key = body.key ?? deriveProjectKey(body.name, taken)

        const usage = new Map(SWATCHES.map((hex) => [hex, 0]))
        for (const p of orgProjects) {
          const hex = p.color?.toUpperCase()
          if (hex && usage.has(hex)) usage.set(hex, usage.get(hex)! + 1)
        }
        const leastUsed = SWATCHES.reduce((best, hex) => (usage.get(hex)! < usage.get(best)! ? hex : best))

        // Slugs are unique per org. A slug taken here, or by a race in this org at insert, gets a random suffix
        const baseSlug = slugify(body.name) || "project"
        // trash: a project in Trash keeps its slug
        const [clash] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.organizationId, orgId), eq(projects.slug, baseSlug)))
          .limit(1)
        let slug = clash ? withSuffix(baseSlug) : baseSlug

        const insertProject = (candidate: string) =>
          tx.transaction((sp) =>
            sp
              .insert(projects)
              .values({
                name: body.name,
                slug: candidate,
                key,
                description: body.description,
                color: body.color || leastUsed,
                icon: body.icon ?? null,
                organizationId: orgId,
                createdBy: user.id,
                createdVia: viaOf(request),
                startDate: body.start_date ? new Date(body.start_date).toISOString() : null,
                endDate: body.end_date ? new Date(body.end_date).toISOString() : null,
              })
              .returning(),
          )

        let row: typeof projects.$inferSelect | undefined
        for (let attempt = 0; !row; attempt++) {
          try {
            ;[row] = await insertProject(slug)
          } catch (error) {
            if (attempt >= 2 || !isUniqueViolation(error)) throw error
            slug = withSuffix(baseSlug)
          }
        }

        await tx.insert(projectMembers).values({
          projectId: row.id,
          userId: user.id,
          role: "admin",
          createdAt: new Date().toISOString(),
        })

        await ensureProjectChat(row.id, tx)
        return row
      })

      if ("refused" in created) return reply.code(409).send({ error: created.refused })
      return reply.code(201).send(await loadProjectDto(created))
    } catch (error) {
      logger.error("Error creating project:", error)
      return reply.code(500).send({ error: "Failed to create project" })
    }
  })

  fastify.get("/:projectId/members", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(projectIdParamsSchema, request.params, reply)
    if (!params) return
    const { projectId } = params

    try {
      const member = orgOf(request)

      const access = await projectReadAccess(user.id, member.organizationId, projectId)

      if (!access) {
        return reply.code(404).send({ error: "Project not found" })
      }

      const members = await db.query.projectMembers.findMany({
        where: eq(projectMembers.projectId, projectId),
        with: {
          user: {
            columns: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
      })

      return reply.send(
        members.map((m) => ({
          ...memberDto(m),
          user: m.user
            ? {
                id: m.user.id,
                email: m.user.email,
                first_name: m.user.firstName,
                last_name: m.user.lastName,
                avatar_url: m.user.avatarUrl,
              }
            : null,
        })),
      )
    } catch (error) {
      logger.error("Error fetching project members:", error)
      return reply.code(500).send({ error: "Failed to fetch project members" })
    }
  })

  fastify.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params

    try {
      const member = orgOf(request)

      const access = await projectReadAccess(user.id, member.organizationId, id)

      if (!access) {
        return reply.code(404).send({ error: "Project not found" })
      }

      return reply.send(await projectReply(access))
    } catch (error) {
      logger.error("Error fetching project:", error)
      return reply.code(500).send({ error: "Failed to fetch project" })
    }
  })

  fastify.get("/slug/:slug", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const p = parseParams(projectSlugParamsSchema, request.params, reply)
    if (!p) return
    const { slug } = p

    try {
      const member = orgOf(request)

      const access = await projectReadAccessBySlug(user.id, member.organizationId, slug)

      if (!access) {
        return reply.code(404).send({ error: "Project not found" })
      }

      return reply.send(await projectReply(access))
    } catch (error) {
      logger.error("Error fetching project:", error)
      return reply.code(500).send({ error: "Failed to fetch project" })
    }
  })

  /** Pins a project to the caller's sidebar. Pinning twice keeps one pin */
  fastify.put("/:slug/pin", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const p = parseParams(projectSlugParamsSchema, request.params, reply)
    if (!p) return

    try {
      const { organizationId } = orgOf(request)
      const pinned = await db.transaction(async (tx) => {
        const access = await projectReadAccessBySlug(user.id, organizationId, p.slug, tx)
        if (!access) return false
        if (access.role === ADMIN_VIEWER) return "read-only" as const
        const projectId = access.project.id
        // Two pins of one project by one user take turns, so the second finds the first
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`project-pin:${user.id.toLowerCase()}:${projectId}`}, 0))`)
        await tx.execute(sql`
            insert into project_pins (user_id, project_id, organization_id)
            select ${user.id}::uuid, ${projectId}::uuid, ${organizationId}::uuid
            where not exists (
              select 1 from project_pins p
              where p.user_id = ${user.id}::uuid and p.project_id = ${projectId}::uuid and p.organization_id = ${organizationId}::uuid
            )`)
        return true
      })
      if (!pinned) return reply.code(404).send({ error: "Project not found" })
      if (pinned === "read-only") return reply.code(403).send(READ_ONLY)
      return reply.send({ pinned: true })
    } catch (error) {
      logger.error("Error pinning project:", error)
      return reply.code(500).send({ error: "Failed to pin the project" })
    }
  })

  /** Takes a project off the caller's sidebar pins. Unpinning twice is fine */
  fastify.delete("/:slug/pin", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const p = parseParams(projectSlugParamsSchema, request.params, reply)
    if (!p) return

    try {
      const { organizationId } = orgOf(request)
      const access = await projectReadAccessBySlug(user.id, organizationId, p.slug)
      if (!access) return reply.code(404).send({ error: "Project not found" })
      if (access.role === ADMIN_VIEWER) return reply.code(403).send(READ_ONLY)
      await db
        .delete(projectPins)
        .where(
          and(
            eq(projectPins.userId, user.id),
            eq(projectPins.projectId, access.project.id),
            eq(projectPins.organizationId, organizationId),
          ),
        )
      return reply.send({ pinned: false })
    } catch (error) {
      logger.error("Error unpinning project:", error)
      return reply.code(500).send({ error: "Failed to unpin the project" })
    }
  })

  fastify.put("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params
    const body = parseBody(projectUpdateBodySchema, request.body, reply)
    if (!body) return

    try {
      const member = orgOf(request)

      const access = await projectReadAccess(user.id, member.organizationId, id)

      if (!access) {
        return reply.code(404).send({ error: "Project not found" })
      }

      const { project } = access
      if (access.role !== "admin") {
        return reply.code(403).send({ error: "Only project owners can update this project" })
      }

      const updateData: Partial<typeof projects.$inferInsert> = {
        name: body.name,
        description: body.description,
        color: body.color,
        icon: body.icon,
        status: body.status,
        startDate: body.start_date ? new Date(body.start_date).toISOString() : undefined,
        endDate: body.end_date ? new Date(body.end_date).toISOString() : undefined,
        updatedAt: new Date().toISOString(),
      }

      const orgId = member.organizationId
      const updatedProject = await db.transaction(async (tx) => {
        if (body.key && body.key !== project.key) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"project-key:" + orgId}))`)
          // trash: a project in Trash keeps its key
          const [clash] = await tx
            .select({ id: projects.id, deletedAt: projects.deletedAt })
            .from(projects)
            .where(and(eq(projects.organizationId, orgId), eq(projects.key, body.key)))
            .limit(1)
          if (clash) return { refused: await keyRefusal(tx, clash, user.id) }
          updateData.key = body.key
        }

        const [row] = await tx
          .update(projects)
          .set(updateData)
          .where(and(eq(projects.id, id), liveProject))
          .returning()
        if (row && row.name !== project.name) {
          await tx.update(groupChats).set({ name: row.name, updatedAt: updateData.updatedAt }).where(eq(groupChats.projectId, id))
        }
        return row
      })

      if (!updatedProject) return reply.code(404).send({ error: "Project not found" })
      if ("refused" in updatedProject) return reply.code(409).send({ error: updatedProject.refused })

      const dto = await loadProjectDto(updatedProject)
      // The project chat shows the project's tile in everyone's chat list
      const tileChanged = updatedProject.icon !== project.icon || updatedProject.color !== project.color
      if (tileChanged && dto.chat_id) chatsChanged(orgId, await groupMemberIds(dto.chat_id))
      return reply.send(dto)
    } catch (error) {
      logger.error("Error updating project:", error)
      return reply.code(500).send({ error: "Failed to update project" })
    }
  })

  fastify.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params

    try {
      const member = orgOf(request)

      // Workspace admins may delete any project in the organization, members or not
      const isOrgAdmin = member.role === "admin"
      const access = isOrgAdmin ? null : await projectAccess(user.id, member.organizationId, id)
      const project = isOrgAdmin
        ? await db.query.projects.findFirst({
            where: and(eq(projects.id, id), eq(projects.organizationId, member.organizationId), liveProject),
          })
        : access?.project

      if (!project) {
        return reply.code(404).send({ error: "Project not found" })
      }

      if (!isOrgAdmin && access?.role !== "admin") {
        return reply.code(403).send({ error: "Only admins can delete this project" })
      }

      const trashed = await trashProject(id, { userId: user.id, organizationId: member.organizationId, isOrgAdmin }, viaOf(request))
      if (!trashed) return reply.code(404).send({ error: "Project not found" })
      return reply.send({ trash: { kind: "project", id: trashed.id } })
    } catch (error) {
      logger.error("Error deleting project:", error)
      return reply.code(500).send({ error: "Failed to delete project" })
    }
  })

  fastify.post("/:id/restore", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return

    try {
      const member = orgOf(request)
      const actor = { userId: user.id, organizationId: member.organizationId, isOrgAdmin: member.role === "admin" }
      const restored = await restoreProject(params.id, actor)
      if (!restored) return reply.code(404).send({ error: "Project not found" })
      const access = await projectReadAccess(user.id, member.organizationId, restored.id)
      if (!access) return reply.code(404).send({ error: "Project not found" })
      return reply.send(await projectReply(access))
    } catch (error) {
      logger.error("Error restoring project:", error)
      return reply.code(500).send({ error: "Failed to restore the project. Try again in a moment" })
    }
  })

  fastify.delete("/:id/forever", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return

    try {
      const member = orgOf(request)
      const actor = { userId: user.id, organizationId: member.organizationId, isOrgAdmin: member.role === "admin" }
      // Only a user who may purge it sees it in Trash, so any other user gets 404
      const rights = await projectTrashAccess(params.id, actor)
      if (!rights?.purge || !(await purgeProject(params.id, member.organizationId, { actor }))) {
        return reply.code(404).send({ error: "Project not found" })
      }
      return reply.send({ message: "Project deleted for good" })
    } catch (error) {
      logger.error("Error deleting project for good:", error)
      return reply.code(500).send({ error: "Failed to delete the project. Try again in a moment" })
    }
  })

  fastify.post("/:projectId/members", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(projectIdParamsSchema, request.params, reply)
    if (!params) return
    const { projectId } = params
    const body = parseBody(projectMemberPostBodySchema, request.body, reply)
    if (!body) return
    const targetUserId = body.user_id ?? body.userId
    if (!targetUserId) {
      return reply.code(400).send({ error: "user_id is required" })
    }
    const role = body.role

    try {
      const member = orgOf(request)

      const access = await projectReadAccess(user.id, member.organizationId, projectId)

      if (!access) {
        return reply.code(404).send({ error: "Project not found" })
      }

      if (access.role !== "admin") {
        return reply.code(403).send({ error: "Only project owners can add members" })
      }

      if (!(await isMemberOf(targetUserId, member.organizationId))) {
        return reply.code(400).send({ error: "User not in organization" })
      }

      const existing = await db.query.projectMembers.findFirst({
        where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)),
      })

      if (existing) {
        return reply.code(400).send({ error: "User is already a project member" })
      }

      const { row: newMember, sync } = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(projectMembers)
          .values({
            projectId,
            userId: targetUserId,
            role: role ?? "member",
            createdAt: new Date().toISOString(),
          })
          .returning()
        return { row, sync: await syncProjectChatMembers(projectId, tx) }
      })
      chatsChanged(member.organizationId, [...sync.added, ...sync.removed])
      void notify(member.organizationId, { type: "project_added", actorId: user.id, projectId, userIds: [targetUserId] })

      return reply.code(201).send(memberDto(newMember))
    } catch (error) {
      logger.error("Error adding project member:", error)
      return reply.code(500).send({ error: "Failed to add project member" })
    }
  })

  /** A workspace admin joins a project of the workspace, as its admin when it has none left. Joining twice is fine */
  fastify.post("/:slug/join", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const p = parseParams(projectSlugParamsSchema, request.params, reply)
    if (!p) return

    try {
      const { organizationId } = orgOf(request)
      const found = await projectReadAccessBySlug(user.id, organizationId, p.slug)
      if (!found) return reply.code(404).send({ error: "Project not found" })
      const projectId = found.project.id

      const sync = await db.transaction(async (tx) => {
        await lockProject(tx, projectId)
        // Taken again under the lock, so a removal or a lost admin role meanwhile is seen
        const access = await projectReadAccess(user.id, organizationId, projectId, tx)
        if (access?.role !== ADMIN_VIEWER) return null
        const rows = await memberRowsInOrg(tx, projectId, organizationId)
        // tenancy: the project was just read inside the caller's workspace, under its lock
        await tx.insert(projectMembers).values({
          projectId,
          userId: user.id,
          role: rows.some((row) => row.role === "admin") ? "member" : "admin",
          createdAt: new Date().toISOString(),
        })
        return syncProjectChatMembers(projectId, tx)
      })
      if (sync) chatsChanged(organizationId, [...sync.added, ...sync.removed])

      const access = await projectReadAccess(user.id, organizationId, projectId)
      if (!access) return reply.code(404).send({ error: "Project not found" })
      // The caller's role now, so the page can say when joining made them the project's admin
      return reply.send({ ...(await projectReply(access)), joined_as: access.role })
    } catch (error) {
      logger.error("Error joining project:", error)
      return reply.code(500).send({ error: "Failed to join the project" })
    }
  })

  fastify.put("/:id/members/:userId", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(projectMemberParamsSchema, request.params, reply)
    if (!params) return
    const { id, userId } = params
    const body = parseBody(projectMemberRolePutBodySchema, request.body, reply)
    if (!body) return
    const { role } = body

    try {
      const member = orgOf(request)

      const access = await projectReadAccess(user.id, member.organizationId, id)

      if (!access) {
        return reply.code(404).send({ error: "Project not found" })
      }

      if (access.role !== "admin") {
        return reply.code(403).send({ error: "Only project owners can change member roles" })
      }

      const changed = await db.transaction(async (tx) => {
        await lockProject(tx, id)
        const rows = await memberRowsInOrg(tx, id, member.organizationId)
        if (removesLastAdmin(rows, userId, role)) return "last-admin" as const
        const [row] = await tx
          .update(projectMembers)
          .set({ role })
          .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)))
          .returning()
        return { row, sync: row ? await syncProjectChatMembers(id, tx) : null }
      })
      if (changed === "last-admin") {
        return reply.code(400).send({ error: LAST_ADMIN_ERROR })
      }
      const { row: updatedMember, sync } = changed
      if (sync) chatsChanged(member.organizationId, [...sync.added, ...sync.removed])

      if (!updatedMember) {
        return reply.code(404).send({ error: "Member not found" })
      }

      return reply.send(memberDto(updatedMember))
    } catch (error) {
      logger.error("Error updating member role:", error)
      return reply.code(500).send({ error: "Failed to update member role" })
    }
  })

  fastify.delete("/:id/members/:userId", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(projectMemberParamsSchema, request.params, reply)
    if (!params) return
    const { id, userId } = params

    try {
      const member = orgOf(request)

      const access = await projectReadAccess(user.id, member.organizationId, id)

      if (!access) {
        return reply.code(404).send({ error: "Project not found" })
      }

      if (access.role === ADMIN_VIEWER) return reply.code(403).send(READ_ONLY)

      // Users can always remove themselves, otherwise only project owners can
      if (user.id !== userId && access.role !== "admin") {
        return reply.code(403).send({ error: "Only project owners can remove other members" })
      }

      const sync = await db.transaction(async (tx) => {
        await leaveProject(tx, id, [userId])
        return syncProjectChatMembers(id, tx)
      })
      chatsChanged(member.organizationId, [...sync.added, ...sync.removed])
      // A doc can reach them through the project's tasks and chat as well as its files, so every one checks again
      closeDocConnections({ userId })
      await finishLeaversTimer(member.organizationId, userId, id)

      return reply.send({ message: "Member removed successfully" })
    } catch (error) {
      logger.error("Error removing project member:", error)
      return reply.code(500).send({ error: "Failed to remove project member" })
    }
  })
}

export default projectRoutes
