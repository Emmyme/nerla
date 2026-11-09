import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { authMiddleware } from "../middleware/auth"
import { decodeCursor, getPrefs, listNotifications, notificationSummary } from "../services/notificationList"
import { markRead, savePrefs } from "../services/notifications"
import { orgMiddleware, orgOf, viewerFor } from "../services/tenancy"
import { parseBody, parseQuery } from "../validation/helpers"
import { notificationListQuerySchema, notificationPrefsBodySchema, notificationReadBodySchema } from "../validation/schemas"

async function notificationRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = parseQuery(notificationListQuerySchema, request.query, reply)
    if (!query) return
    const after = query.cursor ? decodeCursor(query.cursor) : undefined
    if (query.cursor && !after) return reply.code(400).send({ error: "Invalid cursor" })

    try {
      const viewer = viewerFor(request)
      return reply.send(await listNotifications(viewer, after))
    } catch (error) {
      fastify.log.error(error, "Listing notifications failed")
      return reply.code(500).send({ error: "Failed to load notifications" })
    }
  })

  fastify.get("/summary", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send(await notificationSummary(request.user.id, orgOf(request).organizationId))
    } catch (error) {
      fastify.log.error(error, "Loading the notification summary failed")
      return reply.code(500).send({ error: "Failed to load notifications" })
    }
  })

  fastify.post("/read", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(notificationReadBodySchema, request.body, reply)
    if (!body) return

    try {
      return reply.send({ unread: await markRead(request.user.id, orgOf(request).organizationId, body) })
    } catch (error) {
      fastify.log.error(error, "Marking notifications read failed")
      return reply.code(500).send({ error: "Failed to mark notifications read" })
    }
  })

  fastify.post("/read-all", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send({ unread: await markRead(request.user.id, orgOf(request).organizationId, "all") })
    } catch (error) {
      fastify.log.error(error, "Marking all notifications read failed")
      return reply.code(500).send({ error: "Failed to mark notifications read" })
    }
  })

  fastify.get("/prefs", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send({ prefs: await getPrefs(request.user.id, orgOf(request).organizationId) })
    } catch (error) {
      fastify.log.error(error, "Loading notification settings failed")
      return reply.code(500).send({ error: "Failed to load notification settings" })
    }
  })

  fastify.put("/prefs", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(notificationPrefsBodySchema, request.body, reply)
    if (!body) return

    try {
      return reply.send({ prefs: await savePrefs(request.user.id, orgOf(request).organizationId, body.prefs) })
    } catch (error) {
      fastify.log.error(error, "Saving notification settings failed")
      return reply.code(500).send({ error: "Failed to save notification settings" })
    }
  })
}

export default notificationRoutes
