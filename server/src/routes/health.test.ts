import fastify from "fastify"
import { describe, expect, it } from "vitest"
import healthRoutes from "./health"
import type { CheckResult } from "../utils/timedCheck"

const ok: () => Promise<CheckResult> = async () => ({ ok: true, ms: 1 })
const skipped: () => Promise<CheckResult> = async () => ({ ok: true, skipped: true, ms: 0 })
const failing: () => Promise<CheckResult> = async () => ({ ok: false, ms: 2, error: "connect ECONNREFUSED 10.0.0.5:3900" })
const throws: () => Promise<CheckResult> = async () => {
  throw new Error("must not be called")
}

async function appWith(checks: { database: typeof ok; storage: typeof ok; email: typeof ok }) {
  const app = fastify()
  await app.register(import("@fastify/rate-limit"), { max: 5, timeWindow: "1 minute" })
  await app.register(healthRoutes, { checks })
  return app
}

describe("health", () => {
  it("liveness answers without touching anything, and is never rate limited", { timeout: 20_000 }, async () => {
    const app = await appWith({ database: throws, storage: throws, email: throws })
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: "GET", url: "/health" })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: "ok" })
    }
    const ready = await app.inject({ method: "GET", url: "/health/ready" })
    expect(ready.statusCode).toBe(503)
  })

  it.each([
    ["all ok", { database: ok, storage: ok, email: ok }, 200, "ok"],
    ["email failing", { database: ok, storage: ok, email: failing }, 200, "degraded"],
    ["email skipped", { database: ok, storage: ok, email: skipped }, 200, "ok"],
    ["storage failing", { database: ok, storage: failing, email: ok }, 503, "down"],
    ["database failing", { database: failing, storage: ok, email: ok }, 503, "down"],
  ])("readiness with %s", async (_name, checks, code, status) => {
    const app = await appWith(checks)
    const res = await app.inject({ method: "GET", url: "/health/ready" })
    expect(res.statusCode).toBe(code)
    expect(res.json().status).toBe(status)
  })

  it("readiness never tells a stranger why", async () => {
    const app = await appWith({ database: failing, storage: skipped, email: ok })
    const res = await app.inject({ method: "GET", url: "/health/ready" })
    expect(res.json()).toEqual({
      status: "down",
      checks: { database: { ok: false }, storage: { ok: true, skipped: true }, email: { ok: true } },
    })
    expect(res.body).not.toMatch(/ECONNREFUSED|error|"ms"/)
  })
})
