import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { randomUUID } from "node:crypto"
import { authMiddleware } from "../middleware/auth"
import { orgMiddleware, orgOf, outsiders } from "../services/tenancy"
import { parseBody, parseParams, parseQuery } from "../validation/helpers"
import {
  calendarEventCreateBodySchema,
  calendarEventQuerySchema,
  calendarEventUpdateBodySchema,
  calendarFreeQuerySchema,
  calendarRangeQuerySchema,
  calendarRespondBodySchema,
  calendarScopeQuerySchema,
  calendarTeamQuerySchema,
  idParamsSchema,
} from "../validation/schemas"
import { InstantError, parseInstant } from "../utils/eventTime"
import { eventAccess } from "../utils/eventVisibility"
import { viaOf } from "../utils/via"
import { eventChangeRecipients, moveOf } from "../utils/eventNotice"
import { notify } from "../services/notifications"
import { eventTrashRights } from "../utils/trash"
import type { Via } from "../utils/aiTypes"
import { entryNotice, planEdit, PlanError, planRestore, planTrash, type Plan, type SeriesState } from "../utils/seriesEdit"
import {
  announce,
  announcePlan,
  changeSeries,
  createEvent,
  eventTrashEntry,
  freeTimes,
  listMine,
  listTeam,
  loadSeriesState,
  loadVisible,
  type VisibleEvent,
  purgeEvent,
  respondToSeries,
  visibilityOf,
  type Viewer,
} from "../services/calendarQueries"

type Member = Viewer & { role: string }

/** The caller as the calendar sees them, in the workspace orgMiddleware resolved */
const memberOf = (request: FastifyRequest): Member => ({ id: request.user.id, ...orgOf(request) })

function rangeOf(query: { start: string; end: string }) {
  return { from: parseInstant(query.start)!, to: parseInstant(query.end)! }
}

function fail(reply: FastifyReply, error: unknown, fallback: string) {
  if ((error instanceof PlanError || error instanceof InstantError) && error.statusCode < 500) {
    return reply.code(error.statusCode).send({ error: error.message })
  }
  reply.log.error(error, `Calendar request failed: ${fallback}`)
  return reply.code(500).send({ error: fallback })
}

async function guestsOutsideOrg(member: Member, ids: string[] | undefined, reply: FastifyReply): Promise<boolean> {
  if (!ids?.length || (await outsiders(member.organizationId, ids)).length === 0) return false
  reply.code(400).send({ error: "Guests must be members of this workspace" })
  return true
}

const planContext = () => ({ now: new Date().toISOString(), newId: randomUUID })

/** Tells the guests, and the organiser when another user did it, that an entry went to Trash or came back */
function tellEntry(
  member: Member,
  done: { state: SeriesState; plan: Plan },
  entryId: string,
  change: "cancelled" | "restored",
  occurrence: string | undefined,
  via: Via | null,
) {
  const notice = entryNotice(done.state, done.plan, entryId, occurrence)
  if (!notice) return
  const organiserId = (done.state.master ?? done.state.target).createdBy
  const userIds = eventChangeRecipients(notice.guests, member.id, notice.everyone, organiserId)
  if (userIds.length === 0) return
  void notify(member.organizationId, {
    type: "event_changed",
    actorId: member.id,
    eventId: entryId,
    change,
    startsAt: notice.startsAt,
    allDay: notice.allDay,
    userIds,
    organiserId,
    via,
  })
}

/** Tells the users newly invited to an event, never the inviter */
function tellInvited(member: Member, eventId: string, userIds: string[], event: VisibleEvent | null, via: Via | null) {
  const invited = [...new Set(userIds)].filter((id) => id !== member.id)
  if (invited.length === 0 || !event?.starts_at) return
  void notify(member.organizationId, {
    type: "event_changed",
    actorId: member.id,
    eventId,
    change: "invited",
    startsAt: event.starts_at,
    allDay: event.all_day,
    userIds: invited,
    via,
  })
}

async function calendarRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.get("/range", async (request, reply) => {
    const query = parseQuery(calendarRangeQuerySchema, request.query, reply)
    if (!query) return
    const member = memberOf(request)
    try {
      return reply.send(await listMine(member, rangeOf(query)))
    } catch (error) {
      return fail(reply, error, "Failed to fetch events")
    }
  })

  fastify.get("/team", async (request, reply) => {
    const query = parseQuery(calendarTeamQuerySchema, request.query, reply)
    if (!query) return
    const member = memberOf(request)
    try {
      return reply.send(await listTeam(member, query.users, rangeOf(query)))
    } catch (error) {
      return fail(reply, error, "Failed to fetch events")
    }
  })

  fastify.get("/free", async (request, reply) => {
    const query = parseQuery(calendarFreeQuerySchema, request.query, reply)
    if (!query) return
    const member = memberOf(request)
    if (await guestsOutsideOrg(member, query.users, reply)) return
    try {
      const found = await freeTimes(member, query)
      if ("error" in found) return reply.code(400).send({ error: found.error })
      return reply.send(found)
    } catch (error) {
      return fail(reply, error, "Failed to find a time")
    }
  })

  fastify.post("/", async (request, reply) => {
    const body = parseBody(calendarEventCreateBodySchema, request.body, reply)
    if (!body) return
    const member = memberOf(request)
    if (await guestsOutsideOrg(member, body.attendee_ids, reply)) return
    try {
      const { id, guests } = await createEvent(member, body, viaOf(request))
      await announce(member.organizationId, id, [member.id, ...guests], body.everyone === true)
      const event = await loadVisible(member, id)
      tellInvited(member, id, guests, event, viaOf(request))
      return reply.code(201).send(event)
    } catch (error) {
      return fail(reply, error, "Failed to create event")
    }
  })

  fastify.get("/:id", async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return
    const query = parseQuery(calendarEventQuerySchema, request.query, reply)
    if (!query) return
    const member = memberOf(request)
    try {
      const event = await loadVisible(member, params.id, query.calendar)
      if (!event) return reply.code(404).send({ error: "Event not found" })
      return reply.send(event)
    } catch (error) {
      return fail(reply, error, "Failed to fetch event")
    }
  })

  /** Loads the event around `:id` and checks that the caller may change it. */
  async function editable(request: FastifyRequest, reply: FastifyReply, action: "edit" | "delete") {
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return null
    const query = parseQuery(calendarScopeQuerySchema, request.query, reply)
    if (!query) return null
    const member = memberOf(request)
    const state = await loadSeriesState(member.organizationId, params.id)
    if (!state || state.target.deletedAt || state.master?.deletedAt || (state.target.cancelled && action === "edit")) {
      reply.code(404).send({ error: "Event not found" })
      return null
    }
    const creator = (state.master ?? state.target).createdBy
    const visibility = creator === member.id ? "full" : await visibilityOf(member, state.target)
    const access = eventAccess(action, { createdBy: creator }, member, visibility)
    if (access !== "allowed") {
      if (access === "forbidden") {
        reply.code(403).send({ error: `Only the event creator or an admin can ${action} this event` })
      } else {
        reply.code(404).send({ error: "Event not found" })
      }
      return null
    }
    return { member, id: params.id, query }
  }

  /** Plans from rows read under the series lock, then tells everyone involved once it is committed. */
  async function run<P extends Plan>(member: Member, id: string, build: (state: SeriesState) => P) {
    const done = await changeSeries(member.organizationId, id, build)
    if (done) await announcePlan(member.organizationId, member.id, done.state, done.plan)
    return done
  }

  fastify.put("/:id", async (request, reply) => {
    const body = parseBody(calendarEventUpdateBodySchema, request.body, reply)
    if (!body) return
    const found = await editable(request, reply, "edit")
    if (!found) return
    const { member, id, query } = found
    if (await guestsOutsideOrg(member, body.attendee_ids, reply)) return
    try {
      const done = await run(member, id, (state) => planEdit(state, body, query.scope, query.occurrence, planContext()))
      if (!done) return reply.code(404).send({ error: "Event not found" })
      const resultId = done.plan.resultId ?? done.state.target.id
      const move = moveOf(done.state, body, query.occurrence)
      const organiserId = (done.state.master ?? done.state.target).createdBy
      const userIds = move ? eventChangeRecipients(move.guests, member.id, move.everyone, organiserId) : []
      if (move && userIds.length > 0) {
        void notify(member.organizationId, {
          type: "event_changed",
          actorId: member.id,
          eventId: resultId,
          change: "moved",
          startsAt: move.startsAt,
          allDay: move.allDay,
          userIds,
          organiserId,
          via: viaOf(request),
        })
      }
      const event = await loadVisible(member, resultId)
      const { target, master, guests } = done.state
      const before = new Set(
        [...(guests.get(target.id) ?? []), ...(master ? (guests.get(master.id) ?? []) : [])].map((guest) => guest.userId),
      )
      tellInvited(
        member,
        resultId,
        (body.attendee_ids ?? []).filter((userId) => !before.has(userId)),
        event,
        viaOf(request),
      )
      return reply.send(event ?? { id: resultId })
    } catch (error) {
      return fail(reply, error, "Failed to update event")
    }
  })

  fastify.delete("/:id", async (request, reply) => {
    const found = await editable(request, reply, "delete")
    if (!found) return
    const { member, id, query } = found
    const via = viaOf(request)
    try {
      const done = await run(member, id, (state) =>
        planTrash(state, query.scope, query.occurrence, { ...planContext(), by: member.id, via }),
      )
      if (!done) return reply.code(404).send({ error: "Event not found" })
      tellEntry(member, done, done.plan.entryId, "cancelled", query.occurrence, via)
      return reply.send({ trash: { kind: "event", id: done.plan.entryId } })
    } catch (error) {
      return fail(reply, error, "Failed to delete the event. Try again in a moment")
    }
  })

  fastify.post("/:id/restore", async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return
    const member = memberOf(request)
    const viewer = { userId: member.id, isOrgAdmin: member.role === "admin" }
    const via = viaOf(request)
    const notFound = () => reply.code(404).send({ error: "Event not found" })
    try {
      const before = await loadSeriesState(member.organizationId, params.id)
      if (!before) return notFound()
      if (before.target.deletedAt) {
        const entry = await eventTrashEntry(member.organizationId, params.id)
        if (!entry || !eventTrashRights(entry, viewer).restore) return notFound()
      }
      const rows = [before.target, ...(before.master ? [before.master] : []), ...before.overrides, ...(before.strays ?? [])]
      const kept = rows.flatMap((row) => (row.trashRoot === params.id ? (row.trashGuests ?? []) : [])).map((guest) => guest.userId)
      const away = new Set(await outsiders(member.organizationId, [...new Set(kept)]))
      let alreadyBack = false
      const done = await changeSeries(
        member.organizationId,
        params.id,
        (state) => {
          if (!state.target.deletedAt) {
            alreadyBack = true
            return { inserts: [], updates: [], deletes: [], guestAdds: [], guestRemoves: [], resultId: params.id }
          }
          if (!eventTrashRights(state.target, viewer).restore) throw new PlanError(404, "Event not found")
          const plan = planRestore(state, params.id, planContext())
          plan.guestAdds = plan.guestAdds.filter((guest) => !away.has(guest.userId))
          return plan
        },
        { inTrash: true },
      )
      if (!done) return notFound()
      // Already back, so a second Undo or a racing restore succeeds for any user who can see it
      const visible = await loadVisible(member, params.id)
      if (alreadyBack) return visible && !done.state.master?.deletedAt ? reply.send(visible) : notFound()
      await announcePlan(member.organizationId, member.id, done.state, done.plan)
      tellEntry(member, done, params.id, "restored", undefined, via)
      return reply.send(visible ?? { id: params.id })
    } catch (error) {
      return fail(reply, error, "Failed to restore the event. Try again in a moment")
    }
  })

  fastify.delete("/:id/forever", async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return
    const member = memberOf(request)
    const viewer = { userId: member.id, isOrgAdmin: member.role === "admin" }
    try {
      const entry = await eventTrashEntry(member.organizationId, params.id)
      if (!entry || !eventTrashRights(entry, viewer).purge) return reply.code(404).send({ error: "Event not found" })
      const purged = await purgeEvent(params.id, member.organizationId, {
        allowed: (row) => eventTrashRights(row, viewer).purge,
      })
      if (!purged) return reply.code(404).send({ error: "Event not found" })
      return reply.send({ message: "Event deleted for good" })
    } catch (error) {
      return fail(reply, error, "Failed to delete the event. Try again in a moment")
    }
  })

  fastify.post("/:id/respond", async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return
    const body = parseBody(calendarRespondBodySchema, request.body, reply)
    if (!body) return
    const member = memberOf(request)
    try {
      const state = await loadSeriesState(member.organizationId, params.id)
      const visible = state && !state.target.cancelled ? await loadVisible(member, params.id) : null
      if (!state || !visible) return reply.code(404).send({ error: "Event not found" })
      if (!(await respondToSeries(member.id, state, body.response))) {
        return reply.code(403).send({ error: "Only guests can reply to an event" })
      }
      await announcePlan(member.organizationId, member.id, state)
      return reply.send(await loadVisible(member, params.id))
    } catch (error) {
      return fail(reply, error, "Failed to save the reply")
    }
  })
}

export default calendarRoutes
