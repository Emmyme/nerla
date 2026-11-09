import type { FastifyInstance } from "fastify"
import { and, desc, eq, isNull } from "drizzle-orm"
import { aiTokens, db, users } from "../db"
import { authMiddleware } from "../middleware/auth"
import { adminOnly, orgMiddleware, orgOf } from "../services/tenancy"
import { DAY_MS } from "../utils/eventTime"
import { presenceName } from "../utils/presence"
import { newToken } from "../utils/tokenScopes"
import { parseBody, parseParams } from "../validation/helpers"
import { aiTokenBodySchema, aiTokenParamsSchema } from "../validation/schemas"

type TokenRow = typeof aiTokens.$inferSelect

/** Everything about a token apart from its value, which is never kept */
const tokenDto = (row: TokenRow) => ({
  id: row.id,
  name: row.name,
  last4: row.last4,
  scopes: row.scopes,
  readOnly: row.readOnly,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
  lastUsedAt: row.lastUsedAt,
  createdAt: row.createdAt,
})

async function aiTokenRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.get("/", async (request, reply) => {
    try {
      const rows = await db
        .select()
        .from(aiTokens)
        .where(and(eq(aiTokens.organizationId, orgOf(request).organizationId), eq(aiTokens.userId, request.user.id)))
        .orderBy(desc(aiTokens.createdAt))
      return reply.send(rows.map(tokenDto))
    } catch (error) {
      fastify.log.error(error, "Error loading access tokens")
      return reply.code(500).send({ error: "Failed to load your access tokens" })
    }
  })

  fastify.get("/all", { preHandler: adminOnly }, async (request, reply) => {
    try {
      const rows = await db
        .select({ token: aiTokens, firstName: users.firstName, lastName: users.lastName })
        .from(aiTokens)
        .innerJoin(users, eq(users.id, aiTokens.userId))
        .where(eq(aiTokens.organizationId, orgOf(request).organizationId))
        .orderBy(desc(aiTokens.createdAt))
      return reply.send(
        rows.map((row) => ({ ...tokenDto(row.token), owner: { id: row.token.userId, name: presenceName(row.firstName, row.lastName) } })),
      )
    } catch (error) {
      fastify.log.error(error, "Error loading the workspace's access tokens")
      return reply.code(500).send({ error: "Failed to load the access tokens" })
    }
  })

  fastify.post("/", async (request, reply) => {
    const body = parseBody(aiTokenBodySchema, request.body, reply)
    if (!body) return
    try {
      const made = newToken()
      const [row] = await db
        .insert(aiTokens)
        .values({
          organizationId: orgOf(request).organizationId,
          userId: request.user.id,
          name: body.name,
          tokenHash: made.hash,
          last4: made.last4,
          scopes: body.scopes,
          readOnly: body.readOnly,
          expiresAt: body.expiresInDays === null ? null : new Date(Date.now() + body.expiresInDays * DAY_MS).toISOString(),
        })
        .returning()
      reply.header("Cache-Control", "no-store")
      // The only time the value leaves the server
      return reply.code(201).send({ ...tokenDto(row), token: made.token })
    } catch (error) {
      fastify.log.error(error, "Error making an access token")
      return reply.code(500).send({ error: "Failed to make the access token" })
    }
  })

  /** Revocable by the owner or a workspace admin. Other callers get the 404 a missing token gets */
  fastify.post("/:id/revoke", async (request, reply) => {
    const params = parseParams(aiTokenParamsSchema, request.params, reply)
    if (!params) return
    try {
      const org = orgOf(request)
      const mine = org.role === "admin" ? undefined : eq(aiTokens.userId, request.user.id)
      await db
        .update(aiTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(and(eq(aiTokens.id, params.id), eq(aiTokens.organizationId, org.organizationId), mine, isNull(aiTokens.revokedAt)))
      const [row] = await db
        .select()
        .from(aiTokens)
        .where(and(eq(aiTokens.id, params.id), eq(aiTokens.organizationId, org.organizationId), mine))
        .limit(1)
      if (!row) return reply.code(404).send({ error: "Not found" })
      return tokenDto(row)
    } catch (error) {
      fastify.log.error(error, "Error revoking an access token")
      return reply.code(500).send({ error: "Failed to revoke the access token" })
    }
  })
}

export default aiTokenRoutes
