import { eq } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { db, organizationMembers, tokenBlacklist, users } from "../db"
import { verifyAuthToken } from "../services/sessions"
import { testApp } from "../test/app"
import { makeUser, makeWorkspace } from "../test/factories"
import { DAY_MS } from "../utils/eventTime"
import { generateResetToken } from "../utils/resetTokens"

const PASSWORD = "Fresh-start-2026"
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()

let app: FastifyInstance
let orgId: string

/** A session token like signing in makes, started a given number of seconds ago so two never match */
async function session(userId: string, ageSeconds: number): Promise<string> {
  const user = (await db.query.users.findFirst({ where: eq(users.id, userId) }))!
  return app.jwt.sign(
    { id: user.id, email: user.email, role: user.role, tv: user.tokenVersion },
    { expiresIn: "7d", clockTimestamp: Date.now() - ageSeconds * 1000 },
  )
}

const me = async (token: string) =>
  (await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode

/** The same request sent several times at once, each from its own address */
const atOnce = (url: string, payload: object, times = 3) =>
  Promise.all(Array.from({ length: times }, (_, n) => app.inject({ method: "POST", url, payload, remoteAddress: `10.9.0.${n + 1}` }))).then(
    (all) => all.map((res) => res.statusCode).sort(),
  )

beforeAll(async () => {
  app = await testApp()
  ;({ orgId } = await makeWorkspace())
})

afterAll(() => app.close())

describe("signing out", () => {
  it("refuses the signed-out token until it would have expired, and keeps the user's other sessions", async () => {
    const userId = await makeUser(orgId)
    const [laptop, phone] = [await session(userId, 60), await session(userId, 30)]
    expect(laptop).not.toBe(phone)

    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${laptop}` } })
    expect(out.statusCode).toBe(200)

    expect([await me(laptop), await me(phone)]).toEqual([401, 200])
    expect(await verifyAuthToken(app, laptop)).toBeNull()
    const [listed] = await db.select().from(tokenBlacklist).where(eq(tokenBlacklist.token, laptop))
    expect(Date.parse(`${listed.expiresAt}Z`) - Date.now()).toBeGreaterThan(6 * DAY_MS)
  })

  it("signs out every session of the account at once, and only that account", async () => {
    const userId = await makeUser(orgId)
    const coworker = await makeUser(orgId)
    const [laptop, phone, theirs] = [await session(userId, 60), await session(userId, 30), await session(coworker, 30)]

    const out = await app.inject({ method: "POST", url: "/api/auth/logout-all", headers: { authorization: `Bearer ${laptop}` } })
    expect(out.statusCode).toBe(200)

    expect([await me(laptop), await me(phone), await me(theirs)]).toEqual([401, 401, 200])
    const [{ tokenVersion }] = await db.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, userId))
    expect(tokenVersion).toBe(1)
    expect(await me(await session(userId, 0))).toBe(200)
  })

  it("clears the cookie but says so when the token could not be revoked", async () => {
    const userId = await makeUser(orgId)
    const insert = vi.spyOn(db, "insert").mockImplementation(() => {
      throw new Error("database down")
    })
    try {
      for (const url of ["/api/auth/logout", "/api/auth/logout-all"]) {
        const out = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${await session(userId, 60)}` } })
        expect([out.statusCode, out.json()]).toEqual([503, { error: "Couldn't sign you out everywhere. Try again." }])
        expect(out.headers["set-cookie"]).toContain("nerla_jwt=;")
      }
    } finally {
      insert.mockRestore()
    }
  })

  it("signs out every other session when the password is reset", async () => {
    const userId = await makeUser(orgId)
    const before = await session(userId, 30)
    const { token, hash } = generateResetToken()
    await db
      .update(users)
      .set({ passwordHash: "set", passwordResetToken: hash, passwordResetKind: "reset", passwordResetExpires: inAnHour() })
      .where(eq(users.id, userId))

    expect(await atOnce("/api/auth/reset-password", { token, password: PASSWORD }, 1)).toEqual([200])
    expect(await me(before)).toBe(401)
  })
})

describe("a cookie write from another site", () => {
  const logout = async (headers: Record<string, string>) =>
    (await app.inject({ method: "POST", url: "/api/auth/logout", headers })).statusCode
  const cookie = async () => `nerla_jwt=${await session(await makeUser(orgId), 60)}`

  it("is refused", async () => {
    const out = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: await cookie(), origin: "https://evil.example" },
    })
    expect([out.statusCode, out.json()]).toEqual([403, { error: "This request came from another site, so it was refused." }])
  })

  it("passes with a Bearer header, as the desktop app and agents send", async () => {
    const token = await session(await makeUser(orgId), 60)
    expect(await logout({ cookie: await cookie(), authorization: `Bearer ${token}`, origin: "https://evil.example" })).toBe(200)
  })

  it("is refused with any other Authorization header, since the cookie still signs that request in", async () => {
    expect(await logout({ cookie: await cookie(), authorization: "Basic dXNlcjpwYXNz", origin: "https://evil.example" })).toBe(403)
  })

  it("passes from Nerla's own page", async () => {
    expect(await logout({ cookie: await cookie(), origin: "https://nerla.example", host: "nerla.example" })).toBe(200)
  })
})

describe("emailed tokens", () => {
  it("answers an unknown email, an account with a password and a pending invite with a wrong token alike", async () => {
    const userId = await makeUser(orgId)
    const [{ email }] = await db.update(users).set({ passwordHash: "set" }).where(eq(users.id, userId)).returning({ email: users.email })
    const [{ email: invited }] = await db
      .update(users)
      .set({ passwordResetToken: generateResetToken().hash, passwordResetKind: "invite", passwordResetExpires: inAnHour() })
      .where(eq(users.id, await makeUser(orgId)))
      .returning({ email: users.email })
    const [unknown, taken, pending] = await Promise.all(
      [`nobody-${userId}@test.nerla.local`, email, invited].map((address, n) =>
        app.inject({
          method: "POST",
          url: "/api/auth/set-password",
          payload: { email: address, token: "not-a-token", password: PASSWORD },
          remoteAddress: `10.8.0.${n + 1}`,
        }),
      ),
    )
    expect([unknown.statusCode, unknown.json()]).toEqual([
      400,
      { error: "This invite link isn't valid any more. Ask an admin for a new one." },
    ])
    expect([taken.statusCode, taken.json()]).toEqual([unknown.statusCode, unknown.json()])
    expect([pending.statusCode, pending.json()]).toEqual([unknown.statusCode, unknown.json()])
  })

  it("lets a reset token change the password once, even when it is sent several times at once", async () => {
    const userId = await makeUser(orgId)
    const { token, hash } = generateResetToken()
    await db
      .update(users)
      .set({ passwordHash: "old", passwordResetToken: hash, passwordResetKind: "reset", passwordResetExpires: inAnHour() })
      .where(eq(users.id, userId))

    expect(await atOnce("/api/auth/reset-password", { token, password: PASSWORD })).toEqual([200, 400, 400])
    expect(await atOnce("/api/auth/reset-password", { token, password: PASSWORD }, 1)).toEqual([400])
  })

  it("lets an invite token set a first password and join once, even when it is sent several times at once", async () => {
    const userId = await makeUser(orgId)
    await db.delete(organizationMembers).where(eq(organizationMembers.userId, userId))
    const [{ email }] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId))
    const { token, hash } = generateResetToken()
    await db
      .update(users)
      .set({ passwordResetToken: hash, passwordResetKind: "invite", passwordResetExpires: inAnHour() })
      .where(eq(users.id, userId))

    const statuses = await atOnce("/api/auth/set-password", { email, token, password: PASSWORD })
    expect(statuses.filter((status) => status === 200)).toHaveLength(1)
    expect(statuses.every((status) => status === 200 || status === 400)).toBe(true)
    expect(await db.select().from(organizationMembers).where(eq(organizationMembers.userId, userId))).toHaveLength(1)
  })

  it("never takes an invite token as a reset", async () => {
    const userId = await makeUser(orgId)
    const { token, hash } = generateResetToken()
    await db
      .update(users)
      .set({ passwordHash: "old", passwordResetToken: hash, passwordResetKind: "invite", passwordResetExpires: inAnHour() })
      .where(eq(users.id, userId))
    expect(await atOnce("/api/auth/reset-password", { token, password: PASSWORD }, 1)).toEqual([400])
  })
})
