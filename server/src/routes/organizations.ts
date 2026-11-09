import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { authMiddleware } from "../middleware/auth"
import { hasMembership, holdsNoMembership, membersOf, orgAdminMiddleware, orgMemberIds, orgMiddleware, orgOf } from "../services/tenancy"
import { finishLeaversTimer, stopAllTimers } from "../services/timeEntries"
import { sendToUser } from "../services/websocket"
import {
  db,
  users,
  organizations,
  organizationMembers,
  projectMembers,
  projects,
  eventAttendees,
  calendarShareGrants,
  fileGrants,
  fileShareLinks,
  meetingParticipants,
  jobs,
  type Tx,
} from "../db"
import { eq, and, or, isNull, isNotNull, sql, inArray, desc } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { buildInviteUrl, isEmailConfigured } from "../services/email"
import { emailInvite, emailRejoin } from "../services/emailJobs"
import { generateResetToken, isResetTokenExpired } from "../utils/resetTokens"
import { inviteDecision, pendingKind } from "../utils/invites"
import { uploadCeiling } from "../utils/storageCaps"
import { revokeUserSessions } from "../services/sessions"
import { chatsChanged, removeFromOrgChats } from "../services/chats"
import { closeDocConnections } from "../services/collab"
import { syncProjectChatMembers } from "../services/projectChat"
import { leaveProject } from "../services/projectAccess"
import { liveProject } from "../utils/trash"
import { dropMemberNotifications } from "../services/notifications"
import { parseBody, parseParams } from "../validation/helpers"
import {
  orgSettingsBodySchema,
  orgInviteBodySchema,
  orgMemberIdParamsSchema,
  orgMemberRoleBodySchema,
  invitationUserParamsSchema,
} from "../validation/schemas"

const organizationOf = (request: FastifyRequest) =>
  db.query.organizations.findFirst({ where: eq(organizations.id, orgOf(request).organizationId) })

async function inviterNameOf(request: FastifyRequest) {
  const inviter = await db.query.users.findFirst({ where: eq(users.id, request.user.id) })
  return inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() || inviter.email : "An admin"
}

const projectListRateLimit = { max: 60, timeWindow: "1 minute" as const }

const ACCOUNT_EXISTS = "This email already has a Nerla account on this server."

/** A pending invite link or invite back of the caller's workspace, or null for anything else */
async function pendingInviteOf(request: FastifyRequest, userId: string) {
  const target = await db.query.users.findFirst({ where: eq(users.id, userId) })
  if (!target) return null
  const account = {
    organizationId: target.organizationId,
    member: await hasMembership(target.id),
    passwordSet: !!target.passwordHash,
    kind: target.passwordResetKind,
    rejoinUntil: target.rejoinInvitedUntil,
  }
  const kind = pendingKind(account, orgOf(request).organizationId)
  return kind ? { target, kind } : null
}

/** An account no other workspace holds an open invite back for */
const rejoinClaimable = (organizationId: string) =>
  or(
    isNull(users.organizationId),
    eq(users.organizationId, organizationId),
    sql`coalesce(${users.rejoinInvitedUntil} <= ${new Date().toISOString()}, true)`,
  )

const EMAIL_STATUS: Record<string, "sending" | "sent" | "failed"> = {
  pending: "sending",
  running: "sending",
  done: "sent",
  failed: "failed",
}

const PENDING_HERE = "This person already has a pending invitation. Use New link in the list instead."
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Drops the user's attendance, calendar grants either way, the file grants they hold, file shares, outside links and
 * meeting rows in a workspace. File grants they gave stay, and end with their files at the removal deadline.
 */
async function leaveOrgCalendarFilesAndMeetings(tx: Tx, userId: string, organizationId: string) {
  const inOrg = (column: AnyPgColumn) => eq(column, organizationId)
  await tx.delete(eventAttendees).where(and(eq(eventAttendees.userId, userId), inOrg(eventAttendees.organizationId)))
  await tx
    .delete(calendarShareGrants)
    .where(
      and(
        or(eq(calendarShareGrants.ownerId, userId), eq(calendarShareGrants.granteeId, userId)),
        inOrg(calendarShareGrants.organizationId),
      ),
    )
  await tx.delete(fileGrants).where(and(eq(fileGrants.userId, userId), inOrg(fileGrants.organizationId)))
  // Their outside links end for good, and rejoining does not bring them back
  await tx
    .update(fileShareLinks)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(fileShareLinks.createdBy, userId), inOrg(fileShareLinks.organizationId), isNull(fileShareLinks.revokedAt)))
  await tx.delete(meetingParticipants).where(and(eq(meetingParticipants.userId, userId), inOrg(meetingParticipants.organizationId)))
}

async function organizationRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)

  fastify.get("/current", { preHandler: orgMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const org = await organizationOf(request)
      if (!org) {
        return reply.status(403).send({ error: "Not a member of an organization" })
      }
      return reply.send({
        id: org.id,
        name: org.name,
        createdAt: org.createdAt,
        role: orgOf(request).role,
        storageCapPerPerson: org.storageCapPerPerson,
        storageCapTotal: org.storageCapTotal,
        maxFileSize: org.maxFileSize,
        uploadCeiling: uploadCeiling(),
        timeTracking: org.timeTracking,
      })
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ error: "Failed to fetch organization" })
    }
  })

  fastify.get("/members", { preHandler: orgMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const organizationId = orgOf(request).organizationId

      const members = await db.query.organizationMembers.findMany({
        where: eq(organizationMembers.organizationId, organizationId),
        with: {
          user: { columns: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true } },
        },
      })

      const formattedMembers = members.map((member) => ({
        id: member.id,
        userId: member.userId,
        organizationId,
        role: member.role,
        joinedAt: member.createdAt,
        user: {
          id: member.user.id,
          email: member.user.email,
          firstName: member.user.firstName,
          lastName: member.user.lastName,
          avatarUrl: member.user.avatarUrl,
        },
      }))

      return reply.send(formattedMembers)
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ error: "Failed to fetch members" })
    }
  })

  // Admins see names and counts only, never what is inside a project they are not in
  fastify.get(
    "/projects",
    { config: { rateLimit: projectListRateLimit }, preHandler: orgAdminMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const rows = await db
          .select({
            id: projects.id,
            name: projects.name,
            color: projects.color,
            icon: projects.icon,
            status: projects.status,
            member_count: sql<number>`count(distinct ${projectMembers.userId})::int`,
          })
          .from(projects)
          .leftJoin(projectMembers, eq(projectMembers.projectId, projects.id))
          .where(and(eq(projects.organizationId, orgOf(request).organizationId), liveProject))
          .groupBy(projects.id)
          .orderBy(sql`lower(${projects.name})`)

        return reply.send(rows)
      } catch (error) {
        fastify.log.error(error)
        return reply.status(500).send({ error: "Failed to fetch projects" })
      }
    },
  )

  fastify.put("/", { preHandler: orgAdminMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = parseBody(orgSettingsBodySchema, request.body, reply)
      if (!body) return
      const changes: Partial<typeof organizations.$inferInsert> = { updatedAt: new Date().toISOString() }
      if (body.name !== undefined) changes.name = body.name
      if (body.storageCapPerPerson !== undefined) changes.storageCapPerPerson = body.storageCapPerPerson
      if (body.storageCapTotal !== undefined) changes.storageCapTotal = body.storageCapTotal
      if (body.maxFileSize !== undefined) changes.maxFileSize = body.maxFileSize
      if (body.timeTracking !== undefined) changes.timeTracking = body.timeTracking

      const organizationId = orgOf(request).organizationId
      // Holding the row makes a timer or entry being written finish first, so stopping the timers below sees it
      const before = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ timeTracking: organizations.timeTracking })
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .for("update")
        await tx.update(organizations).set(changes).where(eq(organizations.id, organizationId))
        return row
      })

      // Saving off again also stops timers a failed earlier save left running
      if (body.timeTracking === false) await stopAllTimers(organizationId)
      if (body.timeTracking !== undefined && before && body.timeTracking !== before.timeTracking) {
        for (const userId of await orgMemberIds(organizationId)) {
          sendToUser(organizationId, userId, { type: "time:enabled", enabled: body.timeTracking })
        }
      }

      return reply.send({ message: "Organization updated" })
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ error: "Failed to update organization" })
    }
  })

  fastify.post("/invite", { preHandler: orgAdminMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = parseBody(orgInviteBodySchema, request.body, reply)
      if (!parsed) return
      const { email, firstName, lastName, role: inviteRole } = parsed
      const role = inviteRole ?? "member"

      const org = await organizationOf(request)
      if (!org) {
        return reply.status(404).send({ error: "Organization not configured" })
      }

      const inviterName = await inviterNameOf(request)

      // Accounts are per workspace. Only a removed account, which has none, is invited again.
      const existing = await db.query.users.findFirst({
        where: sql`lower(${users.email}) = lower(${email})`,
        columns: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          organizationId: true,
          passwordHash: true,
          rejoinInvitedUntil: true,
        },
      })
      const decision = inviteDecision(
        existing
          ? {
              organizationId: existing.organizationId,
              member: await hasMembership(existing.id),
              passwordSet: !!existing.passwordHash,
              rejoinUntil: existing.rejoinInvitedUntil,
            }
          : null,
        org.id,
      )
      if (decision === "refuse") return reply.status(409).send({ error: ACCOUNT_EXISTS })
      if (decision === "pending") return reply.status(409).send({ error: PENDING_HERE })

      if (existing && decision === "rejoin") {
        // Nothing that could set a password is issued. They rejoin by signing in with the password they have.
        const until = new Date(Date.now() + INVITE_TTL_MS).toISOString()
        const emailed = await db.transaction(async (tx) => {
          const [invited] = await tx
            .update(users)
            .set({ organizationId: org.id, role, rejoinInvitedUntil: until, updatedAt: new Date().toISOString() })
            .where(and(eq(users.id, existing.id), isNotNull(users.passwordHash), rejoinClaimable(org.id), holdsNoMembership()))
            .returning({ id: users.id })
          return invited && emailRejoin(tx, { userId: invited.id, to: existing.email, inviterName, orgName: org.name })
        })
        if (!emailed) return reply.status(409).send({ error: ACCOUNT_EXISTS })

        return reply.status(201).send({
          message: "Invited back. They rejoin the next time they sign in with their existing password.",
          rejoin: true,
          inviteExpiresAt: until,
          email: emailed,
          user: { id: existing.id, email: existing.email, firstName: existing.firstName, lastName: existing.lastName, role },
        })
      }

      // Generate an invite token so the user can verify their identity via set-password
      const invite = generateResetToken()
      const inviteExpires = new Date(Date.now() + INVITE_TTL_MS).toISOString()

      // Org membership is deferred until the user verifies via /set-password
      const created = await db.transaction(async (tx) => {
        const [invitedUser] = await tx
          .insert(users)
          .values({
            email,
            firstName: firstName || email.split("@")[0],
            lastName: lastName || "",
            role,
            emailVerified: false,
            organizationId: org.id,
            passwordResetToken: invite.hash,
            passwordResetExpires: inviteExpires,
            passwordResetKind: "invite",
            createdAt: new Date().toISOString(),
          })
          .onConflictDoNothing({ target: users.email })
          .returning()
        if (!invitedUser) return null
        return {
          invitedUser,
          email: await emailInvite(tx, {
            userId: invitedUser.id,
            to: invitedUser.email,
            token: invite.token,
            inviterName,
            orgName: org.name,
          }),
        }
      })
      if (!created) {
        return reply.status(409).send({ error: ACCOUNT_EXISTS })
      }
      const { invitedUser } = created

      // Only the token's hash is stored, so this reply is the one place the link exists. It can be passed on by hand when SMTP is not set up
      return reply.status(201).send({
        message: "User invited successfully. They must set their password to join.",
        inviteUrl: buildInviteUrl(invitedUser.email, invite.token),
        inviteExpiresAt: inviteExpires,
        email: created.email,
        user: {
          id: invitedUser.id,
          email: invitedUser.email,
          firstName: invitedUser.firstName,
          lastName: invitedUser.lastName,
          role,
          pendingVerification: true,
        },
      })
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ error: "Failed to invite user" })
    }
  })

  // A pending invite is an account with no password that holds this workspace's invite token
  fastify.get("/invitations", { preHandler: orgAdminMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const pending = await db.query.users.findMany({
        where: and(
          eq(users.organizationId, orgOf(request).organizationId),
          or(
            and(isNull(users.passwordHash), eq(users.passwordResetKind, "invite")),
            and(isNotNull(users.passwordHash), isNotNull(users.rejoinInvitedUntil)),
          ),
        ),
        columns: {
          id: true,
          organizationId: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          passwordResetExpires: true,
          passwordResetKind: true,
          rejoinInvitedUntil: true,
          passwordHash: true,
          createdAt: true,
        },
      })

      const members = await membersOf(
        orgOf(request).organizationId,
        pending.map((p) => p.id),
      )
      const listed = pending.flatMap((p) => {
        const kind = pendingKind(
          {
            organizationId: p.organizationId,
            member: members.has(p.id),
            passwordSet: !!p.passwordHash,
            kind: p.passwordResetKind,
            rejoinUntil: p.rejoinInvitedUntil,
          },
          orgOf(request).organizationId,
        )
        if (!kind) return []
        const expiresAt = kind === "rejoin" ? p.rejoinInvitedUntil : p.passwordResetExpires
        return [
          {
            id: p.id,
            email: p.email,
            firstName: p.firstName,
            lastName: p.lastName,
            role: p.role,
            kind,
            invitedAt: p.createdAt,
            expiresAt,
            expired: isResetTokenExpired(expiresAt),
          },
        ]
      })
      if (!isEmailConfigured()) return reply.send(listed.map((invitation) => ({ ...invitation, emailStatus: "not-set-up" })))

      // The latest email job for each user, whether an invite or an invite back
      const userIdOf = sql<string>`${jobs.payload} ->> 'userId'`
      const latest =
        listed.length === 0
          ? []
          : await db
              .selectDistinctOn([userIdOf], { userId: userIdOf, status: jobs.status })
              .from(jobs)
              .where(
                and(
                  inArray(jobs.kind, ["email.invite", "email.rejoin"]),
                  inArray(
                    userIdOf,
                    listed.map((invitation) => invitation.id),
                  ),
                ),
              )
              .orderBy(userIdOf, desc(jobs.createdAt))
      const statusOf = new Map(latest.map((job) => [job.userId, EMAIL_STATUS[job.status]]))
      // No job is left once a sent one is pruned after 7 days, or for an invite older than the queue
      return reply.send(listed.map((invitation) => ({ ...invitation, emailStatus: statusOf.get(invitation.id) ?? null })))
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ error: "Failed to fetch invitations" })
    }
  })

  // Issues a fresh link. Only the newest hash is stored, so the previous link stops working
  fastify.post("/invitations/:userId/link", { preHandler: orgAdminMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = parseParams(invitationUserParamsSchema, request.params, reply)
      if (!params) return

      const pending = await pendingInviteOf(request, params.userId)
      if (pending?.kind !== "invite") {
        return reply.status(404).send({ error: "Invitation not found" })
      }
      const { target } = pending

      const org = await organizationOf(request)
      if (!org) return reply.status(404).send({ error: "Organization not configured" })
      const inviterName = await inviterNameOf(request)

      const expires = new Date(Date.now() + INVITE_TTL_MS).toISOString()
      const invite = generateResetToken()
      const emailed = await db.transaction(async (tx) => {
        const [issued] = await tx
          .update(users)
          .set({ passwordResetToken: invite.hash, passwordResetExpires: expires, passwordResetKind: "invite" })
          .where(and(eq(users.id, target.id), eq(users.organizationId, org.id), isNull(users.passwordHash)))
          .returning({ id: users.id })
        return issued && emailInvite(tx, { userId: issued.id, to: target.email, token: invite.token, inviterName, orgName: org.name })
      })
      if (!emailed) {
        return reply.status(404).send({ error: "Invitation not found" })
      }

      return reply.send({
        inviteUrl: buildInviteUrl(target.email, invite.token),
        inviteExpiresAt: expires,
        email: emailed,
      })
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ error: "Failed to create invite link" })
    }
  })

  // Cancels an invite that was never accepted, so a mistyped address leaves no account behind
  fastify.delete("/invitations/:userId", { preHandler: orgAdminMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = parseParams(invitationUserParamsSchema, request.params, reply)
      if (!params) return

      const pending = await pendingInviteOf(request, params.userId)
      if (!pending) {
        return reply.status(404).send({ error: "Invitation not found" })
      }
      const inOrg = and(eq(users.id, pending.target.id), eq(users.organizationId, orgOf(request).organizationId))

      // A new invitee's account goes with the invite. A removed account invited back keeps its account.
      const [revoked] =
        pending.kind === "rejoin"
          ? await db
              .update(users)
              .set({ organizationId: null, role: "member", rejoinInvitedUntil: null, updatedAt: new Date().toISOString() })
              .where(and(inOrg, isNotNull(users.rejoinInvitedUntil)))
              .returning({ id: users.id })
          : await db
              .delete(users)
              .where(and(inOrg, isNull(users.passwordHash)))
              .returning({ id: users.id })
      if (!revoked) {
        return reply.status(404).send({ error: "Invitation not found" })
      }

      return reply.send({ message: "Invitation revoked" })
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ error: "Failed to revoke invitation" })
    }
  })

  fastify.delete("/members/:memberId", { preHandler: orgAdminMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = parseParams(orgMemberIdParamsSchema, request.params, reply)
      if (!params) return
      const { memberId } = params
      const userId = request.user.id
      const { organizationId } = orgOf(request)

      const targetMember = await db.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.id, memberId)),
      })

      if (!targetMember) {
        return reply.status(404).send({ error: "Member not found" })
      }

      if (targetMember.userId === userId) {
        return reply.status(400).send({ error: "Cannot remove yourself" })
      }

      // Membership alone does not gate every route, so their sessions end first. A failure below
      // leaves the membership in place, so the removal can simply be retried.
      await revokeUserSessions(targetMember.userId)

      const now = new Date().toISOString()
      const changed = await db.transaction(async (tx) => {
        // Every row of theirs in this workspace goes, duplicates included
        await tx
          .delete(organizationMembers)
          .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, targetMember.userId)))
        // They leave the organization's projects, group chats and those chats' call rooms with it
        // trash: projects in Trash too, so a restore never brings them back
        const left = await tx
          .selectDistinct({ projectId: projectMembers.projectId })
          .from(projectMembers)
          .innerJoin(projects, eq(projects.id, projectMembers.projectId))
          .where(and(eq(projectMembers.userId, targetMember.userId), eq(projects.organizationId, organizationId)))
          .orderBy(projectMembers.projectId)
        await removeFromOrgChats(targetMember.userId, organizationId, tx)
        await dropMemberNotifications(tx, targetMember.userId, organizationId)
        await leaveOrgCalendarFilesAndMeetings(tx, targetMember.userId, organizationId)
        await tx
          .update(users)
          // No reset or invite link issued before the removal works after it
          .set({
            organizationId: null,
            role: "member",
            passwordResetToken: null,
            passwordResetExpires: null,
            passwordResetKind: null,
            rejoinInvitedUntil: null,
            // Their own files go 30 days from now
            removedAt: now,
            updatedAt: now,
          })
          .where(and(eq(users.id, targetMember.userId), eq(users.organizationId, organizationId)))
        const changed: string[] = []
        for (const { projectId } of left) {
          await leaveProject(tx, projectId, [targetMember.userId])
          const sync = await syncProjectChatMembers(projectId, tx)
          changed.push(...sync.added, ...sync.removed)
        }
        return changed
      })
      chatsChanged(organizationId, changed)
      closeDocConnections({ userId: targetMember.userId })
      await finishLeaversTimer(organizationId, targetMember.userId)

      return reply.send({ message: "Member removed successfully" })
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ error: "Failed to remove member" })
    }
  })

  fastify.put("/members/:memberId/role", { preHandler: orgAdminMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = parseParams(orgMemberIdParamsSchema, request.params, reply)
      if (!params) return
      const { memberId } = params
      const userId = request.user.id
      const body = parseBody(orgMemberRoleBodySchema, request.body, reply)
      if (!body) return
      const { role } = body
      const { organizationId } = orgOf(request)

      const targetMember = await db.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.id, memberId)),
      })

      if (!targetMember) {
        return reply.status(404).send({ error: "Member not found" })
      }

      if (targetMember.userId === userId) {
        return reply.status(400).send({ error: "Cannot update your own role" })
      }

      const updatedMember = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(organizationMembers)
          .set({ role, updatedAt: new Date().toISOString() })
          .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.id, memberId)))
          .returning()
        if (!row) return null
        // Accounts are per workspace, so the account role is this membership's role
        await tx.update(users).set({ role, updatedAt: new Date().toISOString() }).where(eq(users.id, targetMember.userId))
        return row
      })

      if (!updatedMember) {
        return reply.status(404).send({ error: "Member not found" })
      }

      // The role is a JWT claim, so outstanding tokens must be reissued.
      await revokeUserSessions(targetMember.userId)
      closeDocConnections({ userId: targetMember.userId })

      return reply.send({ message: "Role updated successfully" })
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ error: "Failed to update role" })
    }
  })
}

export default organizationRoutes
