import type { FastifyInstance, FastifyRequest } from "fastify"
import { authMiddleware } from "../middleware/auth"
import { runSetupChecks } from "../services/setupCheck"
import { adminOnly, orgMiddleware } from "../services/tenancy"
import { saveOnboarding } from "../services/onboarding"
import { DESKTOP_ORIGINS } from "../utils/clientUrl"

/** Where the admin opened Nerla, never the desktop app's own origin. A same origin GET carries no Origin header, so the Referer stands in */
function originOf(request: FastifyRequest): string | undefined {
  const { origin, referer } = request.raw.headers
  let found = origin
  if (!found && referer) {
    try {
      found = new URL(referer).origin
    } catch {
      found = undefined
    }
  }
  return found && found !== "null" && !DESKTOP_ORIGINS.includes(found) ? found : undefined
}

async function setupRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.get("/check", { preHandler: adminOnly }, async (request, reply) => {
    const items = await runSetupChecks({
      forwardedFor: request.raw.headers["x-forwarded-for"] !== undefined,
      proxyIgnored: (request.ips?.length ?? 0) < 2,
      proxyAddress: request.ip,
      origin: originOf(request),
    })
    // Ticks the admin's getting started step once storage and email both work
    const clear = ["storage", "email"].every((id) => items.some((item) => item.id === id && item.status === "ok"))
    if (clear) await saveOnboarding(request.user.id, { setupClearAt: new Date().toISOString() })
    return reply.send({ items })
  })
}

export default setupRoutes
