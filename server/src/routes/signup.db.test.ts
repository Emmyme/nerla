import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { testApp } from "../test/app"

let app: FastifyInstance

beforeAll(async () => {
  app = await testApp()
})

afterAll(() => app.close())

describe("the first signup", () => {
  it("makes one admin when several arrive at once", async () => {
    const statuses = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        app.inject({
          method: "POST",
          url: "/api/auth/signup",
          remoteAddress: `10.9.0.${n}`,
          payload: { email: `first${n}@example.test`, password: "Str0ng!Passw0rd", organizationName: `Workspace ${n}` },
        }),
      ),
    ).then((replies) => replies.map((reply) => reply.statusCode).sort())
    expect(statuses).toEqual([200, 403, 403, 403])
  })
})
