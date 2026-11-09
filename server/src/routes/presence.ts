import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { and, eq, inArray } from "drizzle-orm"
import { authMiddleware } from "../middleware/auth"
import { orgMiddleware, orgOf } from "../services/tenancy"
import { db, organizationMembers, users } from "../db"
import { parseBody } from "../validation/helpers"
import { presenceQueryBodySchema, presenceStatusBodySchema } from "../validation/schemas"
import { availabilitiesFor } from "../services/calendarQueries"
import { livePresence, statusChanged, statusesEnded } from "../services/presence"
import { activeStatus, availabilityShown, presenceSeenBy, statusExpired } from "../utils/statusOverride"
import { parseInstant } from "../utils/eventTime"
import { addJob, cancelJobs } from "../jobs/queue"

const statusRateLimit = { max: 30, timeWindow: "1 minute" as const }

async function presenceRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  /** The live state and calendar availability of up to 200 users, only those in the caller's organization */
  fastify.post("/query", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(presenceQueryBodySchema, request.body, reply)
    if (!body) return
    try {
      const ids = [...new Set(body.ids)]
      if (ids.length === 0) return reply.send({ people: {} })
      const { organizationId } = orgOf(request)
      const people = await db
        .select({
          id: users.id,
          timeZone: users.timeZone,
          workingHours: users.workingHours,
          statusOverride: users.statusOverride,
          statusUntil: users.statusUntil,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(eq(organizationMembers.organizationId, organizationId), inArray(organizationMembers.userId, ids)))
      const calendar = await availabilitiesFor({ id: request.user.id, organizationId }, people)
      const nowMs = Date.now()
      const result: Record<string, unknown> = {}
      for (const person of people) {
        const now = calendar.get(person.id)
        const status = activeStatus(person.statusOverride, person.statusUntil, nowMs)
        const self = person.id === request.user.id.toLowerCase()
        const live = livePresence(person.id)
        const calendarShown = availabilityShown(live, status, self)
        result[person.id] = {
          ...presenceSeenBy(live, status, self),
          availability: (calendarShown && now?.availability) || { kind: null },
          ...(calendarShown && now?.changesAt ? { changesAt: new Date(now.changesAt).toISOString() } : {}),
        }
      }
      statusesEnded(people.filter((person) => statusExpired(person.statusOverride, person.statusUntil, nowMs)).map((person) => person.id))
      return reply.send({ people: result })
    } catch (error) {
      fastify.log.error(error, "Error querying presence")
      return reply.status(500).send({ error: "Failed to load presence" })
    }
  })

  /** Sets the caller's own status, or "auto" to go back to the automatic one */
  fastify.put("/status", { config: { rateLimit: statusRateLimit } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(presenceStatusBodySchema, request.body, reply)
    if (!body) return
    try {
      const userId = request.user.id.toLowerCase()
      const previousRow = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { statusOverride: true, statusUntil: true },
      })
      const nowMs = Date.now()
      const previous = activeStatus(previousRow?.statusOverride, previousRow?.statusUntil, nowMs)
      const untilMs = body.status === "auto" || !body.until ? null : parseInstant(body.until)
      const value = body.status === "auto" ? null : body.status
      const until = untilMs === null ? null : new Date(untilMs)
      const { organizationId } = orgOf(request)
      const uniqueKey = `status:${userId}`
      await db.transaction(async (tx) => {
        await tx.update(users).set({ statusOverride: value, statusUntil: until }).where(eq(users.id, userId))
        await cancelJobs(tx, uniqueKey)
        // shortcut: while the old status's clear job runs it holds the key, so this end is left to a read, retry the add if that shows up
        if (value && until)
          await addJob(tx, "status.clear", { userId, organizationId, value, until: until.toISOString() }, { runAt: until, uniqueKey })
      })
      const status = activeStatus(value, until, nowMs)
      statusChanged(userId, organizationId, status, previous)
      return reply.send({ status })
    } catch (error) {
      fastify.log.error(error, "Error setting status")
      return reply.status(500).send({ error: "Failed to set your status" })
    }
  })
}

export default presenceRoutes
