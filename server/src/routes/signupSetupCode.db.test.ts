import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { testApp } from "../test/app"

let app: FastifyInstance
let address = 0

beforeAll(async () => {
  process.env.SETUP_TOKEN = "setup-code-from-setup-sh"
  app = await testApp()
})

afterAll(async () => {
  delete process.env.SETUP_TOKEN
  await app.close()
})

const signup = (setupCode?: string) =>
  app.inject({
    method: "POST",
    url: "/api/auth/signup",
    remoteAddress: `10.8.0.${++address}`,
    payload: { email: "owner@example.test", password: "Str0ng!Passw0rd", organizationName: "Workspace", setupCode },
  })

describe("the first signup with a setup code", () => {
  it("is asked for, refused without the right code and accepted with it", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/setup-status" })).json()).toEqual({ needsSetup: true, setupCode: true })
    expect((await signup()).statusCode).toBe(403)
    expect((await signup("a-guess")).statusCode).toBe(403)
    expect((await signup(" setup-code-from-setup-sh ")).statusCode).toBe(200)
    expect((await app.inject({ method: "GET", url: "/api/auth/setup-status" })).json()).toEqual({ needsSetup: false, setupCode: false })
  })
})
