import type { FastifyInstance, FastifyRequest } from "fastify"
import { and, eq } from "drizzle-orm"
import { db, fileAttachments } from "../db"
import { authMiddleware } from "../middleware/auth"
import { sendAvatar } from "../services/avatars"
import {
  AiRefusal,
  aiAvailable,
  ensureWorkspaceAi,
  modelChoice,
  personalAi,
  savePersonalAi,
  saveWorkspaceAi,
  workspaceAi,
  type AiPersonalRow,
  type AiSettingsRow,
} from "../services/aiSettings"
import { listActivity, usageSummary } from "../services/aiActivity"
import { answerHeld, listHeld } from "../services/aiCards"
import { preferencesOf, replacePreferences } from "../services/aiMemory"
import { testModel } from "../services/aiModel"
import { clearSummary, summaryOf } from "../services/aiSummary"
import { askInDm, clearThread, stopRequest, stopWorkspaceAi, teammateFor, testConnection } from "../services/aiTeammate"
import { threadPage } from "../services/aiThread"
import { adminOnly, orgMiddleware, orgOf } from "../services/tenancy"
import { answerer } from "./helpers"
import { parseBody, parseParams, parseQuery } from "../validation/helpers"
import {
  aiActivityQuerySchema,
  aiAvatarParamsSchema,
  aiHeldBodySchema,
  aiHeldParamsSchema,
  aiPersonalBodySchema,
  aiPreferencesBodySchema,
  aiRequestParamsSchema,
  aiSettingsBodySchema,
  aiThreadPostBodySchema,
  aiThreadQuerySchema,
} from "../validation/schemas"

const avatarPath = (org: Pick<AiSettingsRow, "avatarFileId">) => (org.avatarFileId ? `/ai/avatar/${org.avatarFileId}` : null)

/** Every setting, with the last 4 characters of the key in its place */
const settingsDto = (row: AiSettingsRow) => ({
  enabled: row.enabled,
  mcpEnabled: row.mcpEnabled,
  baseUrl: row.baseUrl,
  model: row.model,
  keyLast4: row.keyLast4,
  name: row.name,
  avatarUrl: avatarPath(row),
  monthlyBudget: row.monthlyBudget,
  personBudget: row.personBudget,
  allowPersonalKey: row.allowPersonalKey,
  allowPersonalUrl: row.allowPersonalUrl,
  localNetwork: row.localNetwork,
  strictness: row.strictness,
})

const personalDto = (org: AiSettingsRow | null, row: AiPersonalRow | null) => ({
  available: aiAvailable(org),
  // Members need it to find their access tokens while only MCP is on
  mcpEnabled: !!org?.mcpEnabled,
  name: org?.name ?? "Nerla AI",
  avatarUrl: org ? avatarPath(org) : null,
  allowKey: !!org && (org.allowPersonalKey || org.allowPersonalUrl),
  allowUrl: !!org?.allowPersonalUrl,
  workspaceStrictness: org?.strictness ?? "tainted",
  baseUrl: row?.baseUrl ?? null,
  model: row?.model ?? null,
  keyLast4: row?.keyLast4 ?? null,
  strictness: row?.strictness ?? null,
})

const askerOf = (request: FastifyRequest) => {
  const org = orgOf(request)
  return { userId: request.user.id, organizationId: org.organizationId, isAdmin: org.role === "admin" }
}

async function aiRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  const answer = answerer(fastify.log, AiRefusal)

  fastify.get("/settings", { preHandler: adminOnly }, (request, reply) =>
    answer(reply, "Failed to load AI settings", async () => settingsDto(await ensureWorkspaceAi(orgOf(request).organizationId))),
  )

  fastify.put("/settings", { preHandler: adminOnly }, async (request, reply) => {
    const body = parseBody(aiSettingsBodySchema, request.body, reply)
    if (!body) return
    return answer(reply, "Failed to save AI settings", async () => {
      const saved = await saveWorkspaceAi({ organizationId: orgOf(request).organizationId, userId: request.user.id }, body)
      if (!saved.enabled) stopWorkspaceAi(saved.organizationId)
      return settingsDto(saved)
    })
  })

  fastify.post("/settings/test", { preHandler: adminOnly }, (request, reply) =>
    answer(reply, "Failed to test the connection", async () => {
      const choice = modelChoice(await workspaceAi(orgOf(request).organizationId), null)
      return { ok: choice ? await testModel(choice) : false }
    }),
  )

  fastify.get("/avatar/:fileId", async (request, reply) => {
    const params = parseParams(aiAvatarParamsSchema, request.params, reply)
    if (!params) return
    try {
      const { organizationId } = orgOf(request)
      const org = await workspaceAi(organizationId)
      const attachment =
        org?.avatarFileId === params.fileId
          ? await db.query.fileAttachments.findFirst({
              where: and(eq(fileAttachments.id, params.fileId), eq(fileAttachments.organizationId, organizationId)),
            })
          : undefined
      if (!attachment) return reply.code(404).send({ error: "File not found" })
      return await sendAvatar(reply, attachment)
    } catch (error) {
      fastify.log.error(error, "Error serving the AI avatar")
      return reply.code(500).send({ error: "Failed to serve avatar" })
    }
  })

  fastify.get("/me", (request, reply) =>
    answer(reply, "Failed to load your AI settings", async () => {
      const { organizationId } = orgOf(request)
      return personalDto(await workspaceAi(organizationId), await personalAi(request.user.id, organizationId))
    }),
  )

  fastify.put("/me", async (request, reply) => {
    const body = parseBody(aiPersonalBodySchema, request.body, reply)
    if (!body) return
    return answer(reply, "Failed to save your AI settings", async () => {
      const viewer = { organizationId: orgOf(request).organizationId, userId: request.user.id }
      const org = await workspaceAi(viewer.organizationId)
      return personalDto(org, await savePersonalAi(viewer, org, body))
    })
  })

  fastify.post("/me/test", (request, reply) =>
    answer(reply, "Failed to test the connection", async () => ({ ok: await testConnection(askerOf(request)) })),
  )

  // The user's own memory. No route reads another user's, an admin's included
  fastify.get("/me/memory", (request, reply) =>
    answer(reply, "Failed to load your AI memory", async () => {
      const viewer = { userId: request.user.id, organizationId: orgOf(request).organizationId }
      return { preferences: await preferencesOf(viewer), summary: await summaryOf(viewer) }
    }),
  )

  fastify.delete("/me/summary", (request, reply) =>
    answer(reply, "Failed to clear your chat summary", async () => {
      await clearSummary({ userId: request.user.id, organizationId: orgOf(request).organizationId })
      return { ok: true }
    }),
  )

  fastify.put("/me/preferences", async (request, reply) => {
    const body = parseBody(aiPreferencesBodySchema, request.body, reply)
    if (!body) return
    return answer(reply, "Failed to save your preferences", async () => ({
      preferences: await replacePreferences({ userId: request.user.id, organizationId: orgOf(request).organizationId }, body),
    }))
  })

  fastify.get("/held", (request, reply) =>
    answer(reply, "Failed to load what waits for your Allow", () =>
      listHeld({ userId: request.user.id, organizationId: orgOf(request).organizationId }),
    ),
  )

  fastify.post("/held/:id", async (request, reply) => {
    const params = parseParams(aiHeldParamsSchema, request.params, reply)
    if (!params) return
    const body = parseBody(aiHeldBodySchema, request.body, reply)
    if (!body) return
    return answer(reply, "Failed to answer", () => answerHeld(askerOf(request), params.id, body.decision, body.chosen))
  })

  fastify.get("/teammate", (request, reply) =>
    answer(reply, "Failed to load the AI teammate", async () => {
      const { available, org } = await teammateFor(askerOf(request))
      return { available, name: org?.name ?? "Nerla AI", avatarUrl: org ? avatarPath(org) : null }
    }),
  )

  fastify.get("/thread", async (request, reply) => {
    const query = parseQuery(aiThreadQuerySchema, request.query, reply)
    if (!query) return
    return answer(reply, "Failed to load your chat with the AI", () => threadPage(askerOf(request), query.before))
  })

  fastify.post("/thread", async (request, reply) => {
    const body = parseBody(aiThreadPostBodySchema, request.body, reply)
    if (!body) return
    return answer(reply, "Failed to send", async () => {
      const sent = await askInDm(askerOf(request), body.content)
      return { requestId: sent.requestId, message: { ...sent.message, clientId: body.clientId ?? null } }
    })
  })

  // Only the user's own chat, with its summary and waiting cards
  fastify.delete("/thread", (request, reply) =>
    answer(reply, "Failed to clear your chat with the AI", async () => {
      await clearThread(askerOf(request))
      return { ok: true }
    }),
  )

  fastify.post("/requests/:id/stop", async (request, reply) => {
    const params = parseParams(aiRequestParamsSchema, request.params, reply)
    if (!params) return
    try {
      if (!(await stopRequest(askerOf(request), params.id))) return reply.code(404).send({ error: "Not found" })
      return reply.send({ ok: true })
    } catch (error) {
      fastify.log.error(error, "Failed to stop the request")
      return reply.code(500).send({ error: "Failed to stop the request" })
    }
  })

  fastify.get("/activity", async (request, reply) => {
    const query = parseQuery(aiActivityQuerySchema, request.query, reply)
    if (!query) return
    const org = orgOf(request)
    if (query.scope === "workspace" && org.role !== "admin") return reply.code(404).send({ error: "Not found" })
    return answer(reply, "Failed to load the activity", () =>
      listActivity({ userId: request.user.id, organizationId: org.organizationId }, query.scope),
    )
  })

  fastify.get("/usage", (request, reply) => answer(reply, "Failed to load the usage", () => usageSummary(askerOf(request))))
}

export default aiRoutes
