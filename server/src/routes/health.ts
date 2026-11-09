import type { FastifyPluginAsync } from "fastify"
import { defaultChecks, readiness, type Checks } from "../services/health"

const unlimited = { rateLimit: false }

/** Liveness says the process runs. Readiness says what it can reach, without saying why anything failed */
const healthRoutes: FastifyPluginAsync<{ checks?: Checks }> = async (app, options) => {
  const checks = options.checks ?? defaultChecks

  app.get("/health", { config: unlimited }, async () => ({ status: "ok" }))

  app.get("/health/ready", { config: unlimited }, async (_request, reply) => {
    const { status, checks: results } = await readiness(checks)
    const open = (name: keyof Checks) => ({ ok: results[name].ok, ...(results[name].skipped ? { skipped: true } : {}) })
    return reply
      .code(status === "down" ? 503 : 200)
      .send({ status, checks: { database: open("database"), storage: open("storage"), email: open("email") } })
  })
}

export default healthRoutes
