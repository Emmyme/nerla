import type { FastifyInstance } from "fastify"
import { Readable } from "stream"
import { authMiddleware } from "../middleware/auth"
import { orgMiddleware, orgOf, viewerFor } from "../services/tenancy"
import {
  createEntry,
  deleteEntry,
  markChecksSeen,
  saveTimeSettings,
  startTimer,
  stopTimer,
  taskTime,
  timeState,
  timeTrackingOn,
  TimeRefusal,
  updateEntry,
} from "../services/timeEntries"
import { placeImpact, setTimeLocks, timeLocks, timeReport, timeReportCsv } from "../services/timeReports"
import { dismissSuggestion, weekOf } from "../services/timeWeek"
import { viaOf } from "../utils/via"
import { parseBody, parseParams, parseQuery } from "../validation/helpers"
import {
  timeChecksSeenBodySchema,
  timeDismissalBodySchema,
  timeEntryCreateBodySchema,
  timeEntryParamsSchema,
  timeEntryPatchBodySchema,
  timeImpactQuerySchema,
  timeLocksBodySchema,
  timeReportQuerySchema,
  timeSettingsBodySchema,
  timeTaskParamsSchema,
  timeTimerBodySchema,
  timeWeekQuerySchema,
} from "../validation/schemas"
import { answerer } from "./helpers"

async function timeRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  const answer = answerer(fastify.log, TimeRefusal)

  fastify.get("/state", (request, reply) => answer(reply, "Failed to load time tracking", () => timeState(viewerFor(request))))

  // Every other route answers 404 while the workspace has time tracking off
  fastify.register(async (on) => {
    on.addHook("preHandler", async (request, reply) => {
      if (!(await timeTrackingOn(orgOf(request).organizationId))) return reply.code(404).send({ error: "Not found" })
    })

    on.post("/checks/seen", async (request, reply) => {
      const body = parseBody(timeChecksSeenBodySchema, request.body, reply)
      if (!body) return
      return answer(reply, "Failed to update entries", async () => {
        await markChecksSeen(viewerFor(request), body.ids)
        return { message: "Marked seen" }
      })
    })

    on.get("/week", async (request, reply) => {
      const query = parseQuery(timeWeekQuerySchema, request.query, reply)
      if (!query) return
      return answer(reply, "Failed to load the week", () => weekOf(viewerFor(request), query.start))
    })

    on.post("/dismissals", async (request, reply) => {
      const body = parseBody(timeDismissalBodySchema, request.body, reply)
      if (!body) return
      return answer(reply, "Failed to dismiss the suggestion", async () => {
        await dismissSuggestion(viewerFor(request), body.key)
        return { message: "Dismissed" }
      })
    })

    on.post("/entries", async (request, reply) => {
      const body = parseBody(timeEntryCreateBodySchema, request.body, reply)
      if (!body) return
      return answer(reply, "Failed to log time", async () => ({ entry: await createEntry(viewerFor(request), body, viaOf(request)) }))
    })

    on.patch("/entries/:id", async (request, reply) => {
      const params = parseParams(timeEntryParamsSchema, request.params, reply)
      if (!params) return
      const body = parseBody(timeEntryPatchBodySchema, request.body, reply)
      if (!body) return
      return answer(reply, "Failed to update the entry", async () => ({ entry: await updateEntry(viewerFor(request), params.id, body) }))
    })

    on.delete("/entries/:id", async (request, reply) => {
      const params = parseParams(timeEntryParamsSchema, request.params, reply)
      if (!params) return
      return answer(reply, "Failed to delete the entry", async () => {
        await deleteEntry(viewerFor(request), params.id)
        return { message: "Entry deleted" }
      })
    })

    on.post("/timer", async (request, reply) => {
      const body = parseBody(timeTimerBodySchema, request.body, reply)
      if (!body) return
      return answer(reply, "Failed to start the timer", () => startTimer(viewerFor(request), body))
    })

    on.post("/timer/stop", (request, reply) => answer(reply, "Failed to stop the timer", () => stopTimer(viewerFor(request))))

    on.get("/tasks/:taskId", async (request, reply) => {
      const params = parseParams(timeTaskParamsSchema, request.params, reply)
      if (!params) return
      return answer(reply, "Failed to load time on the task", () => taskTime(viewerFor(request), params.taskId))
    })

    on.get("/reports", async (request, reply) => {
      const query = parseQuery(timeReportQuerySchema, request.query, reply)
      if (!query) return
      return answer(reply, "Failed to load the report", () => timeReport(viewerFor(request), query))
    })

    on.get("/reports.csv", async (request, reply) => {
      const query = parseQuery(timeReportQuerySchema, request.query, reply)
      if (!query) return
      return answer(reply, "Failed to export the report", async () => {
        const lines = await timeReportCsv(viewerFor(request), query)
        reply
          .header("Content-Type", "text/csv; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="time-${query.from}-${query.to}.csv"`)
        return Readable.from(lines)
      })
    })

    on.get("/locks", (request, reply) => answer(reply, "Failed to load locks", () => timeLocks(viewerFor(request))))

    on.put("/locks", async (request, reply) => {
      const body = parseBody(timeLocksBodySchema, request.body, reply)
      if (!body) return
      return answer(reply, "Failed to save locks", () => setTimeLocks(viewerFor(request), body.projectIds, body.until))
    })

    on.get("/impact", async (request, reply) => {
      const query = parseQuery(timeImpactQuerySchema, request.query, reply)
      if (!query) return
      return answer(reply, "Failed to load time on it", () => placeImpact(viewerFor(request), query))
    })

    on.put("/settings", async (request, reply) => {
      const body = parseBody(timeSettingsBodySchema, request.body, reply)
      if (!body) return
      return answer(reply, "Failed to save time settings", () => saveTimeSettings(viewerFor(request), body.autofillProjectId))
    })
  })
}

export default timeRoutes
