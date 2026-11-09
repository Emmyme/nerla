import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { ownProfile } from "../utils/userProfile"
import { authMiddleware, extractAuthToken } from "../middleware/auth"
import { db, users, organizations, organizationMembers } from "../db"
import { hasMembership, soleOrganizationId } from "../services/tenancy"
import { rejoinsOnSignIn, tokenUsableFor } from "../utils/invites"
import { eq, and, count, isNull, sql } from "drizzle-orm"
import bcrypt from "bcryptjs"
import { parseBody } from "../validation/helpers"
import {
  signupBodySchema,
  signinBodySchema,
  setPasswordBodySchema,
  forgotPasswordBodySchema,
  resetPasswordBodySchema,
} from "../validation/schemas"
import { blacklistToken } from "../services/tokenBlacklist"
import { signAuthToken, revokeUserSessions } from "../services/sessions"
import { closeDocConnections } from "../services/collab"
import { emailReset } from "../services/emailJobs"
import { setAuthCookie, clearAuthCookie, isKnownDevice, rememberDevice } from "../utils/authCookie"
import { generateResetToken, isResetTokenExpired, resetTokenMatches } from "../utils/resetTokens"
import { hashToken } from "../utils/tokenScopes"
import { tooManyRequests } from "./helpers"

const BCRYPT_ROUNDS = 12
/** A hash at BCRYPT_ROUNDS of a random string nobody kept, compared when an account is missing */
// nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash -- a hash of a discarded random string, not a credential
const DUMMY_HASH = "$2a$12$Sl9CqyB1bblAOhq3dpRXvux5u987rs6GhO0e41JWcjSJfWoYkZD12"
const SIGN_OUT_FAILED = "Couldn't sign you out everywhere. Try again."
const INVITE_INVALID = { error: "This invite link isn't valid any more. Ask an admin for a new one." }
const REGISTRATION_CLOSED = { error: "Registration is closed. Ask your admin for an invite." }
const RESET_INVALID = { error: "Invalid or expired reset token" }
const RESET_SENT = "If that email exists, a reset link has been generated."
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000

/** Stricter than the app-wide limit, and only for /signin and /signup. */
const credentialRateLimit = {
  max: 10,
  timeWindow: "1 minute" as const,
  keyGenerator: (request: { ip: string }) => request.ip,
  errorResponseBuilder: tooManyRequests("Too many login attempts. Please wait before trying again."),
}

/** The route and email a credential request is about, as the limiter keys it. Empty when the body has no usable email, which the schema then refuses */
function emailOf(request: FastifyRequest): string {
  const email = (request.body as { email?: unknown } | null)?.email
  if (typeof email !== "string" || email.length > 255) return ""
  const key = email.trim().toLowerCase()
  return key && `${request.routeOptions.url}:${key}`
}

/** Only desktop needs the token in the body, the website has the cookie. */
function isDesktopClient(request: FastifyRequest): boolean {
  return request.headers["x-nerla-client"] === "desktop"
}

interface PublicUser {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  avatarUrl: string | null
  role: string
}

function toPublicUser(user: PublicUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
    role: user.role,
  }
}

/** A removed account that a workspace invited back joins it on its next sign-in */
async function rejoinIfInvitedBack(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [account] = await tx
      .select({ organizationId: users.organizationId, role: users.role, rejoinUntil: users.rejoinInvitedUntil })
      .from(users)
      .where(eq(users.id, userId))
      .for("update")
    if (!account?.organizationId || !account.rejoinUntil) return
    const member = await hasMembership(userId, tx)
    const rejoins = rejoinsOnSignIn({ organizationId: account.organizationId, member, rejoinUntil: account.rejoinUntil })
    if (rejoins) {
      await tx.insert(organizationMembers).values({
        organizationId: account.organizationId,
        userId,
        role: account.role === "admin" ? "admin" : "member",
        createdAt: new Date().toISOString(),
      })
    }
    // Rejoining cancels the purge of their files
    await tx
      .update(users)
      .set(rejoins ? { rejoinInvitedUntil: null, removedAt: null } : { rejoinInvitedUntil: null })
      .where(eq(users.id, userId))
  })
}

// Strangers get 10 tries an email from all addresses together. A browser that signed in to it before skips this count
const FAILED_SIGNINS_MAX = 10
const FAILED_SIGNINS_MS = 60_000
const FAILED_SIGNINS_KEPT = 5000
// shortcut: counts sit in this process's memory like the other limits. Past FAILED_SIGNINS_KEPT emails the expired go first, then the oldest
const failedSignins = new Map<string, { count: number; until: number }>()

/** Takes one try for this email before the password is checked, so tries sent all at once still count. When none are left it gives when they come back */
function takeSigninTry(key: string): { until: number } | true {
  const now = Date.now()
  const live = failedSignins.get(key)
  const entry = live && live.until > now ? live : { count: 0, until: now + FAILED_SIGNINS_MS }
  if (entry.count >= FAILED_SIGNINS_MAX) return entry
  entry.count++
  failedSignins.delete(key)
  failedSignins.set(key, entry)
  if (failedSignins.size > FAILED_SIGNINS_KEPT) {
    for (const [k, e] of failedSignins) if (e.until <= now) failedSignins.delete(k)
    if (failedSignins.size > FAILED_SIGNINS_KEPT) failedSignins.delete(failedSignins.keys().next().value!)
  }
  return true
}

async function authRoutes(fastify: FastifyInstance) {
  // Guesses at one account from many addresses count together. The reply is the per-address one, so it never says whether the account exists
  const emailLimit = fastify.createRateLimit({ max: 10, timeWindow: "1 minute", keyGenerator: emailOf })
  const tooMany = (reply: FastifyReply, seconds: number) =>
    reply.code(429).header("retry-after", String(seconds)).send(credentialRateLimit.errorResponseBuilder())
  const perEmail = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!emailOf(request)) return
    const limit = await emailLimit(request)
    if (limit.isAllowed || !limit.isExceeded) return
    return tooMany(reply, limit.ttlInSeconds)
  }
  fastify.get("/setup-status", async (_request, reply) => {
    const [{ value: userCount }] = await db.select({ value: count() }).from(users)
    return reply.send({ needsSetup: userCount === 0 })
  })

  fastify.get("/me", { preHandler: [authMiddleware] }, async (request, reply) => {
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.id, request.user.id),
      })

      if (!user) {
        return reply.status(404).send({ error: "User not found" })
      }

      return reply.send({
        ...toPublicUser(user),
        ...ownProfile(user),
        emailVerified: user.emailVerified,
        lastLogin: user.lastLoginAt,
        createdAt: user.createdAt,
      })
    } catch (error) {
      fastify.log.error(error, "Get user error")
      return reply.status(500).send({ error: "Failed to get user information" })
    }
  })

  fastify.post("/logout", { preHandler: [authMiddleware] }, async (request, reply) => {
    clearAuthCookie(reply)
    const token = extractAuthToken(request)
    try {
      if (token) await blacklistToken(token)
    } catch (error) {
      fastify.log.error(error, "Revoking a token at sign-out failed")
      return reply.status(503).send({ error: SIGN_OUT_FAILED })
    }
    return reply.send({ message: "Logged out successfully" })
  })

  fastify.post("/logout-all", { preHandler: [authMiddleware] }, async (request, reply) => {
    clearAuthCookie(reply)
    const token = extractAuthToken(request)
    try {
      if (token) await blacklistToken(token)
      await revokeUserSessions(request.user.id)
    } catch (error) {
      fastify.log.error(error, "Revoking sessions at sign-out failed")
      return reply.status(503).send({ error: SIGN_OUT_FAILED })
    }
    closeDocConnections({ userId: request.user.id })
    return reply.send({ message: "All sessions revoked" })
  })

  // Only the first user signs up, as the admin. All other users are invited
  fastify.post("/signup", { config: { rateLimit: credentialRateLimit } }, async (request, reply) => {
    try {
      const [{ value: userCount }] = await db.select({ value: count() }).from(users)

      if (userCount > 0) {
        return reply.status(403).send(REGISTRATION_CLOSED)
      }

      const parsed = parseBody(signupBodySchema, request.body, reply)
      if (!parsed) return
      const { email, password, firstName, lastName, organizationName } = parsed

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

      // Signups at the same moment wait on one lock, so only the first becomes the admin
      const user = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('first-signup', 0))`)
        const [{ value: existing }] = await tx.select({ value: count() }).from(users)
        if (existing > 0) return null
        const [made] = await tx
          .insert(users)
          .values({
            email,
            firstName: firstName || "",
            lastName: lastName || "",
            passwordHash,
            role: "admin",
            emailVerified: true,
          })
          .returning()
        const [org] = await tx.insert(organizations).values({ name: organizationName }).returning()
        await tx.insert(organizationMembers).values({ organizationId: org.id, userId: made.id, role: "admin" })
        await tx.update(users).set({ organizationId: org.id }).where(eq(users.id, made.id))
        return made
      })
      if (!user) return reply.status(403).send(REGISTRATION_CLOSED)

      const token = signAuthToken(fastify, user)

      setAuthCookie(reply, token)
      return reply.send({
        message: "Signup successful",
        user: toPublicUser(user),
        ...(isDesktopClient(request) ? { token } : {}),
      })
    } catch (error) {
      fastify.log.error(error, "Signup error")
      return reply.status(500).send({ error: "Signup failed" })
    }
  })

  // An invited user sets a first password here, on an account that has none yet
  fastify.post("/set-password", { config: { rateLimit: credentialRateLimit }, preHandler: perEmail }, async (request, reply) => {
    try {
      const parsed = parseBody(setPasswordBodySchema, request.body, reply)
      if (!parsed) return
      const { email, password, token: inviteToken } = parsed

      const user = await db.query.users.findFirst({
        where: eq(users.email, email),
      })

      // A missing account, a set password and a wrong token answer alike, so the form never tells a stranger which accounts exist
      if (!user || user.passwordHash) return reply.status(400).send(INVITE_INVALID)

      const usable = tokenUsableFor("invite", { kind: user.passwordResetKind, passwordSet: false })
      if (!usable || !resetTokenMatches(inviteToken, user.passwordResetToken)) return reply.status(400).send(INVITE_INVALID)

      if (isResetTokenExpired(user.passwordResetExpires)) {
        return reply.status(400).send({ error: "Invite token has expired. Ask your admin for a new invite." })
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
      // The inviting workspace, or the only workspace when the account has none
      const organizationId = user.organizationId ?? (await soleOrganizationId())

      // One token, one account: the update only lands while the row still holds the token and workspace read above
      const updated = await db.transaction(async (tx) => {
        await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("update")
        const [row] = await tx
          .update(users)
          .set({
            passwordHash,
            emailVerified: true,
            passwordResetToken: null,
            passwordResetExpires: null,
            passwordResetKind: null,
            lastLoginAt: new Date().toISOString(),
            organizationId,
          })
          .where(
            and(
              eq(users.id, user.id),
              isNull(users.passwordHash),
              eq(users.passwordResetToken, user.passwordResetToken!),
              sql`${users.organizationId} is not distinct from ${user.organizationId}`,
            ),
          )
          .returning()
        if (!row) return null

        // Membership is granted now that the invite is proven
        if (organizationId && !(await hasMembership(user.id, tx))) {
          await tx.insert(organizationMembers).values({
            organizationId,
            userId: user.id,
            role: row.role === "admin" ? "admin" : "member",
            createdAt: new Date().toISOString(),
          })
        }
        return row
      })
      if (!updated) return reply.status(400).send(INVITE_INVALID)

      const token = signAuthToken(fastify, updated)

      setAuthCookie(reply, token)
      return reply.send({
        message: "Password set successfully",
        user: toPublicUser(updated),
        ...(isDesktopClient(request) ? { token } : {}),
      })
    } catch (error) {
      fastify.log.error(error, "Set password error")
      return reply.status(500).send({ error: "Failed to set password" })
    }
  })

  fastify.post("/forgot-password", { config: { rateLimit: credentialRateLimit }, preHandler: perEmail }, async (request, reply) => {
    try {
      const parsed = parseBody(forgotPasswordBodySchema, request.body, reply)
      if (!parsed) return

      const user = await db.query.users.findFirst({
        where: eq(users.email, parsed.email),
      })

      // Always return success to prevent user enumeration
      if (!user || !user.passwordHash) {
        return reply.send({ message: RESET_SENT })
      }

      const { token, hash } = generateResetToken()
      const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString()

      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ passwordResetToken: hash, passwordResetExpires: expires, passwordResetKind: "reset" })
          .where(eq(users.id, user.id))
        await emailReset(tx, { userId: user.id, to: user.email, token })
      })

      const response: Record<string, unknown> = { message: RESET_SENT }
      // Opt-in only, so a deployment with an unset NODE_ENV cannot leak the token
      if (process.env.EXPOSE_RESET_TOKEN === "true") {
        response.resetToken = token
      }

      return reply.send(response)
    } catch (error) {
      fastify.log.error(error, "Forgot password error")
      return reply.status(500).send({ error: "Failed to process request" })
    }
  })

  fastify.post("/reset-password", { config: { rateLimit: credentialRateLimit } }, async (request, reply) => {
    try {
      const parsed = parseBody(resetPasswordBodySchema, request.body, reply)
      if (!parsed) return

      const user = await db.query.users.findFirst({
        where: eq(users.passwordResetToken, hashToken(parsed.token)),
      })

      const usable = !!user && tokenUsableFor("reset", { kind: user.passwordResetKind, passwordSet: !!user.passwordHash })
      if (!user || !usable || isResetTokenExpired(user.passwordResetExpires)) {
        return reply.status(400).send(RESET_INVALID)
      }

      const passwordHash = await bcrypt.hash(parsed.password, BCRYPT_ROUNDS)

      const [updated] = await db
        .update(users)
        .set({
          passwordHash,
          passwordResetToken: null,
          passwordResetExpires: null,
          passwordResetKind: null,
        })
        // Single use: a second reset with the same token finds it gone
        .where(and(eq(users.id, user.id), eq(users.passwordResetToken, hashToken(parsed.token)), eq(users.passwordResetKind, "reset")))
        .returning()
      if (!updated) {
        return reply.status(400).send(RESET_INVALID)
      }

      // A reset is what a compromised user does, so every other session ends with it
      const tokenVersion = await revokeUserSessions(user.id)
      closeDocConnections({ userId: user.id })
      const token = signAuthToken(fastify, { ...updated, tokenVersion })

      setAuthCookie(reply, token)
      return reply.send({
        message: "Password reset successfully",
        user: toPublicUser(updated),
        ...(isDesktopClient(request) ? { token } : {}),
      })
    } catch (error) {
      fastify.log.error(error, "Reset password error")
      return reply.status(500).send({ error: "Failed to reset password" })
    }
  })

  fastify.post("/signin", { config: { rateLimit: credentialRateLimit } }, async (request, reply) => {
    try {
      const parsed = parseBody(signinBodySchema, request.body, reply)
      if (!parsed) return
      const { email, password } = parsed

      const user = await db.query.users.findFirst({
        where: eq(users.email, email),
      })
      // The try is taken before the compare, with no wait between, so tries sent all at once still count. A good sign-in clears it
      if (!isKnownDevice(request, email, user?.passwordHash)) {
        const taken = takeSigninTry(emailOf(request))
        if (taken !== true) return tooMany(reply, Math.ceil((taken.until - Date.now()) / 1000))
      }

      // A missing account still costs one compare, so the answer time never tells a stranger which accounts exist
      const ok = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH)
      if (!user?.passwordHash || !ok) {
        return reply.status(401).send({ error: "Invalid email or password" })
      }
      failedSignins.delete(emailOf(request))
      const known = rememberDevice(request, reply, email, user.passwordHash)

      await db.update(users).set({ lastLoginAt: new Date().toISOString() }).where(eq(users.id, user.id))
      if (user.rejoinInvitedUntil) await rejoinIfInvitedBack(user.id)

      const token = signAuthToken(fastify, user)

      setAuthCookie(reply, token)
      return reply.send({
        message: "Signin successful",
        user: toPublicUser(user),
        ...(isDesktopClient(request) ? { token, known } : {}),
      })
    } catch (error) {
      fastify.log.error(error, "Signin error")
      return reply.status(500).send({ error: "Signin failed" })
    }
  })
}

export default authRoutes
