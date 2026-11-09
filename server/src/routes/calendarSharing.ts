import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { authMiddleware } from "../middleware/auth"
import { parseBody } from "../validation/helpers"
import { calendarSharingBodySchema } from "../validation/schemas"
import { announceSharing, getSharing, saveSharing } from "../services/calendarQueries"
import { orgMiddleware, orgOf, outsiders } from "../services/tenancy"

/** Who can see the caller's calendar in other users' Team view (spec 4.8) */
async function calendarSharingRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { user } = request
    try {
      return reply.send(await getSharing(user.id, orgOf(request).organizationId))
    } catch (error) {
      fastify.log.error(error, "Error fetching calendar sharing")
      return reply.code(500).send({ error: "Failed to fetch calendar sharing" })
    }
  })

  fastify.put("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const { user } = request
    const body = parseBody(calendarSharingBodySchema, request.body, reply)
    if (!body) return
    const member = orgOf(request)

    const grantees = (body.grants ?? []).map((grant) => grant.grantee_id)
    if (grantees.includes(user.id)) return reply.code(400).send({ error: "You always see your own calendar" })
    if ((await outsiders(member.organizationId, grantees)).length) {
      return reply.code(400).send({ error: "Grants must go to members of this workspace" })
    }
    try {
      await saveSharing(user.id, member.organizationId, body)
      // Saved already, so a failed nudge to viewers must not fail the request
      await announceSharing(member.organizationId, user.id).catch((error) => fastify.log.error(error, "Error announcing calendar sharing"))
      return reply.send(await getSharing(user.id, member.organizationId))
    } catch (error) {
      fastify.log.error(error, "Error saving calendar sharing")
      return reply.code(500).send({ error: "Failed to save calendar sharing" })
    }
  })
}

export default calendarSharingRoutes
