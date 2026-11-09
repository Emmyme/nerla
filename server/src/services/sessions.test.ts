import jwt from "@fastify/jwt"
import Fastify from "fastify"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { TOKEN_PREFIX } from "../utils/tokenScopes"

const rows = vi.hoisted(() => ({ revoked: false, tokenVersion: 3, down: false }))

vi.mock("../db", async () => ({
  ...(await import("../db/schema")),
  db: {
    query: {
      tokenBlacklist: {
        findFirst: async () => (rows.down ? Promise.reject(new Error("down")) : rows.revoked ? { token: "t" } : undefined),
      },
      users: { findFirst: async () => ({ tokenVersion: rows.tokenVersion }) },
    },
  },
}))

import { signAuthToken, verifyAuthToken } from "./sessions"

const app = Fastify()
const user = { id: "u1", email: "ada@example.com", role: "member", tokenVersion: 3 }

beforeAll(async () => {
  await app.register(jwt, { secret: "a-test-secret-that-is-long-enough-for-hs256" })
  await app.ready()
})

afterAll(() => app.close())

beforeEach(() => Object.assign(rows, { revoked: false, tokenVersion: 3, down: false }))

describe("verifyAuthToken", () => {
  it("accepts a signed token while it is not revoked and its version is current", async () => {
    const token = signAuthToken(app, user)
    expect(await verifyAuthToken(app, token)).toMatchObject({ id: "u1", tv: 3 })
    rows.tokenVersion = 4
    expect(await verifyAuthToken(app, token)).toBeNull()
  })

  it("gives two sign-ins in the same second tokens of their own", () => {
    expect(signAuthToken(app, user)).not.toBe(signAuthToken(app, user))
  })

  it("refuses a signed-out token, and every token while the revocation list can't be read", async () => {
    const token = signAuthToken(app, user)
    rows.revoked = true
    expect(await verifyAuthToken(app, token)).toBeNull()
    rows.revoked = false
    rows.down = true
    expect(await verifyAuthToken(app, token)).toBeNull()
  })

  it("refuses an agent's access token, a changed token and one without a version", async () => {
    const token = signAuthToken(app, user)
    expect(await verifyAuthToken(app, `${TOKEN_PREFIX}abc`)).toBeNull()
    expect(await verifyAuthToken(app, `${token.slice(0, -2)}xx`)).toBeNull()
    const unversioned = { id: "u1", email: "ada@example.com", role: "member" } as Parameters<typeof app.jwt.sign>[0]
    expect(await verifyAuthToken(app, app.jwt.sign(unversioned))).toBeNull()
  })
})
