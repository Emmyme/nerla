import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import { authMiddleware } from "../middleware/auth"
import { orgMiddleware, viewerFor } from "../services/tenancy"
import { listTrash, readTrashCursor } from "../services/trashList"
import { parseQuery } from "../validation/helpers"

const trashQuerySchema = z.strictObject({
  kind: z.enum(["all", "files", "uploads", "docs", "tasks", "events", "projects"]).default("all"),
  cursor: z.string().max(100).optional(),
})

async function trashRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = parseQuery(trashQuerySchema, request.query, reply)
    if (!query) return
    const before = query.cursor ? readTrashCursor(query.cursor) : null
    if (query.cursor && !before) return reply.code(400).send({ error: "Invalid cursor" })
    const viewer = viewerFor(request)
    try {
      return reply.send(await listTrash(viewer, query.kind, before))
    } catch (error) {
      fastify.log.error(error, "Trash list failed")
      return reply.code(500).send({ error: "Failed to load the trash. Try again in a moment" })
    }
  })
}

export default trashRoutes
