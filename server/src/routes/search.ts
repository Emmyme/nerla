import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { authMiddleware } from "../middleware/auth"
import { searchEverything } from "../services/search"
import { orgMiddleware, viewerFor } from "../services/tenancy"
import { parseQuery } from "../validation/helpers"
import { searchQuerySchema } from "../validation/schemas"

async function searchRoutes(fastify: FastifyInstance) {
  // A looser limit per address before auth, so requests without a valid token are limited too
  const perAddress = fastify.createRateLimit({ max: 300, timeWindow: "1 minute", keyGenerator: (request) => request.ip })
  fastify.addHook("onRequest", async (request, reply) => {
    const limit = await perAddress(request)
    if (limit.isAllowed || !limit.isExceeded) return
    return reply.code(429).header("retry-after", String(limit.ttlInSeconds)).send({ error: "Too many searches, try again in a moment" })
  })
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = parseQuery(searchQuerySchema, request.query, reply)
    if (!query) return
    const viewer = viewerFor(request)
    try {
      return reply.send(await searchEverything(viewer, query.q))
    } catch (error) {
      fastify.log.error(error, "Search failed")
      return reply.code(500).send({ error: "Search failed" })
    }
  })
}

export default searchRoutes
