import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { authMiddleware } from "../middleware/auth"
import { db, users, fileAttachments, fileLinks, organizationMembers } from "../db"
import { eq, and, or, ilike, inArray, notExists, sql } from "drizzle-orm"
import { sendAvatar } from "../services/avatars"
import { parseParams, parseQuery, parseBody } from "../validation/helpers"
import {
  onboardingPutSchema,
  userAvatarParamsSchema,
  userIdParamsSchema,
  userProfilePutSchema,
  userSearchQuerySchema,
} from "../validation/schemas"
import { isSafeInlineImageType } from "../utils/mimeValidation"
import { normalizeProfile, ownProfile, profileFor } from "../utils/userProfile"
import { availabilityFor } from "../services/calendarQueries"
import { isMemberOf, memberIdsOf, orgMiddleware, orgOf, resolveOrg } from "../services/tenancy"
import { isRefusal } from "../utils/tenancy"
import { purgeFile } from "../services/files"
import { livePresence } from "../services/presence"
import { activeStatus, availabilityShown } from "../utils/statusOverride"
import { onboardingFor, saveOnboarding } from "../services/onboarding"

const avatarPath = (fileId: string) => `/users/avatar/${fileId}`

const ownProfileDto = (user: typeof users.$inferSelect) => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  avatarUrl: user.avatarUrl,
  role: user.role,
  ...ownProfile(user),
})

async function userRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)

  fastify.get("/avatar/:fileId", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = parseParams(userAvatarParamsSchema, request.params, reply)
      if (!params) return
      const { fileId } = params
      const viewerId = request.user.id
      const notFound = () => reply.code(404).send({ error: "File not found" })

      // Only a member's current avatar in the viewer's workspace is served, any other id answers like a random one
      const viewerOrg = await resolveOrg(viewerId)
      if (isRefusal(viewerOrg)) return notFound()
      const attachment = await db.query.fileAttachments.findFirst({
        where: and(eq(fileAttachments.id, fileId), eq(fileAttachments.organizationId, viewerOrg.organizationId)),
      })
      if (!attachment) return notFound()

      const owner = await db.query.users.findFirst({
        where: and(eq(users.avatarFileId, fileId), eq(users.id, attachment.uploadedBy)),
        columns: { id: true },
      })
      if (!owner) return notFound()
      if (owner.id !== viewerId && !(await isMemberOf(owner.id, viewerOrg.organizationId))) return notFound()

      return sendAvatar(reply, attachment)
    } catch (error) {
      fastify.log.error(error, "Error serving avatar")
      return reply.code(500).send({ error: "Failed to serve avatar" })
    }
  })

  fastify.get("/profile", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.id, request.user.id),
      })

      if (!user) {
        return reply.status(404).send({ error: "User not found" })
      }

      return reply.send(ownProfileDto(user))
    } catch (error) {
      fastify.log.error(error, "Error fetching user profile")
      return reply.status(500).send({ error: "Failed to get user profile" })
    }
  })

  fastify.put("/profile", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user.id
      const body = parseBody(userProfilePutSchema, request.body, reply)
      if (!body) return

      const fields = normalizeProfile(body)
      if (!fields.ok) return reply.status(400).send({ error: fields.error })

      const updateData: Record<string, unknown> = {
        ...fields.values,
        updatedAt: new Date().toISOString(),
      }

      const current = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { avatarFileId: true },
      })
      if (!current) {
        return reply.status(404).send({ error: "User not found" })
      }

      // Merged in the database, so two devices changing different choices keep both
      if (body.accessibility !== undefined) {
        updateData.accessibility = sql`coalesce(${users.accessibility}, '{}'::jsonb) || ${JSON.stringify(body.accessibility)}::jsonb`
      }

      if (body.firstName !== undefined) updateData.firstName = body.firstName || null
      if (body.lastName !== undefined) updateData.lastName = body.lastName || null

      if (body.avatarFileId !== undefined) {
        if (body.avatarFileId === null) {
          updateData.avatarFileId = null
          updateData.avatarUrl = null
        } else {
          const file = await db.query.fileAttachments.findFirst({
            where: and(
              eq(fileAttachments.id, body.avatarFileId),
              eq(fileAttachments.uploadedBy, userId),
              eq(fileAttachments.kind, "avatar"),
            ),
            columns: { id: true, mimeType: true },
          })

          if (!file) {
            return reply.status(404).send({ error: "Avatar file not found" })
          }

          if (!isSafeInlineImageType(file.mimeType)) {
            return reply.status(400).send({ error: "Avatar must be a JPEG, PNG, GIF, WebP, AVIF, or BMP image" })
          }

          updateData.avatarFileId = file.id
          updateData.avatarUrl = avatarPath(file.id)
        }
      }

      const [updatedUser] = await db.update(users).set(updateData).where(eq(users.id, userId)).returning()

      if (!updatedUser) {
        return reply.status(404).send({ error: "User not found" })
      }

      const previous = current.avatarFileId
      if (previous && previous !== updatedUser.avatarFileId) {
        try {
          // tenancy: bounded by uploaded_by, so only the user's own avatar row matches
          const old = await db.query.fileAttachments.findFirst({
            where: and(
              eq(fileAttachments.id, previous),
              eq(fileAttachments.uploadedBy, userId),
              eq(fileAttachments.kind, "avatar"),
              notExists(
                // tenancy: the links of the row above, which uploaded_by already bounds to the user's own avatar
                db.select({ id: fileLinks.id }).from(fileLinks).where(eq(fileLinks.fileId, previous)),
              ),
            ),
            columns: { id: true },
          })
          // Purged only while it is still an unposted avatar of the user's that nothing uses
          if (old) {
            await purgeFile(old.id, {
              expect: "any",
              condition: sql`f.kind = 'avatar' and f.uploaded_by = ${userId}::uuid
                and not exists (select 1 from file_links l where l.file_id = f.id)
                and not exists (select 1 from users au where au.avatar_file_id = f.id)
                and not exists (select 1 from group_chats g where g.avatar_file_id = f.id)`,
            })
          }
        } catch (error) {
          fastify.log.error(error, "Error removing the previous avatar")
        }
      }

      return reply.send(ownProfileDto(updatedUser))
    } catch (error) {
      fastify.log.error(error, "Error updating user profile")
      return reply.status(500).send({ error: "Failed to update user profile" })
    }
  })

  fastify.get("/onboarding", { preHandler: orgMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user.id
      // The desktop app names itself on every request, so opening it ticks the desktop step
      if (request.headers["x-nerla-client"] === "desktop") await saveOnboarding(userId, { desktopDone: true })
      return reply.send(await onboardingFor(userId, orgOf(request)))
    } catch (error) {
      fastify.log.error(error, "Error loading onboarding")
      return reply.status(500).send({ error: "Failed to load getting started" })
    }
  })

  fastify.put("/onboarding", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = parseBody(onboardingPutSchema, request.body, reply)
      if (!body) return
      const now = new Date().toISOString()
      await saveOnboarding(
        request.user.id,
        { ...(body.welcomeSeen && { welcomeSeenAt: now }), ...(body.checklistDismissed && { checklistDismissedAt: now }) },
        { skipped: body.skip && [body.skip], tips: body.tip && [body.tip] },
      )
      return reply.send({ ok: true })
    } catch (error) {
      fastify.log.error(error, "Error saving onboarding")
      return reply.status(500).send({ error: "Failed to save getting started" })
    }
  })

  fastify.get("/search", { preHandler: orgMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = parseQuery(userSearchQuerySchema, request.query, reply)
      if (!query) return

      const searchPattern = `%${query.q}%`
      const foundUsers = await db.query.users.findMany({
        where: and(
          inArray(users.id, memberIdsOf(orgOf(request).organizationId)),
          or(ilike(users.email, searchPattern), ilike(users.firstName, searchPattern), ilike(users.lastName, searchPattern)),
        ),
        columns: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
        limit: 20,
      })

      return reply.send(foundUsers)
    } catch (error) {
      fastify.log.error(error, "Error searching users")
      return reply.status(500).send({ error: "Failed to search users" })
    }
  })

  /** A user's card for the profile popover. Users outside the caller's organization are not found */
  fastify.get("/:id", { preHandler: orgMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(userIdParamsSchema, request.params, reply)
    if (!params) return
    try {
      const { organizationId } = orgOf(request)
      const member = await db.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, params.id)),
        columns: { organizationId: true, role: true },
        with: {
          user: {
            columns: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              avatarUrl: true,
              jobTitle: true,
              team: true,
              location: true,
              timeZone: true,
              pronouns: true,
              phone: true,
              workingHours: true,
              statusOverride: true,
              statusUntil: true,
            },
          },
        },
      })
      if (!member || !profileFor(organizationId, member)) return reply.code(404).send({ error: "User not found" })
      const { user } = member
      const self = user.id === request.user.id.toLowerCase()
      // The same mask as presence, so "That's a secret" hides the calendar here too
      const shown = availabilityShown(livePresence(user.id), activeStatus(user.statusOverride, user.statusUntil, Date.now()), self)
      const availability = shown ? await availabilityFor({ id: request.user.id, organizationId }, user) : undefined
      return reply.send(profileFor(organizationId, member, availability))
    } catch (error) {
      fastify.log.error(error, "Error fetching user")
      return reply.status(500).send({ error: "Failed to fetch user" })
    }
  })
}

export default userRoutes
