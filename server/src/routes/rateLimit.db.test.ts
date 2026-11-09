import bcrypt from "bcryptjs"
import { eq } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { db, users } from "../db"
import { signedIn, testApp } from "../test/app"
import { makeUser, makeWorkspace } from "../test/factories"

let app: FastifyInstance
let ids: string[]
let emails: string[]
const PASSWORD = "Right@1234"

// A scaled limiter: 10 a minute per address, 5 reads and 2 writes per user
beforeAll(async () => {
  process.env.RATE_LIMIT_MAX = "10"
  app = await testApp()
  const { orgId, adminId } = await makeWorkspace()
  ids = [adminId, await makeUser(orgId), await makeUser(orgId), await makeUser(orgId), await makeUser(orgId), await makeUser(orgId)]
  // A cheap hash keeps the sign-in rows fast
  const passwordHash = await bcrypt.hash(PASSWORD, 4)
  emails = []
  for (const id of ids.slice(3)) {
    const [row] = await db.update(users).set({ passwordHash }).where(eq(users.id, id)).returning({ email: users.email })
    emails.push(row.email)
  }
})

afterAll(async () => {
  delete process.env.RATE_LIMIT_MAX
  await app.close()
})

async function send(method: "GET" | "POST", url: string, remoteAddress: string, who?: string, payload?: object) {
  const headers = who ? await signedIn(app, who) : undefined
  return (await app.inject({ method, url, headers, remoteAddress, payload })).statusCode
}

describe("rate limits", () => {
  it.each([
    [
      "two users behind one address each get a budget",
      async () => {
        const codes = []
        for (let i = 0; i < 6; i++) codes.push(await send("GET", "/api/users/profile", "10.9.0.1", ids[0]))
        return [codes[4], codes[5], await send("GET", "/api/users/profile", "10.9.0.1", ids[1])]
      },
      [200, 429, 200],
    ],
    [
      "a user's writes run out before their reads",
      async () => {
        const writes = []
        for (let i = 0; i < 3; i++) writes.push(await send("POST", "/api/tasks", `10.9.1.${i}`, ids[2], {}))
        return [writes.map((code) => code === 429), await send("GET", "/api/users/profile", "10.9.1.9", ids[2])]
      },
      [[false, false, true], 200],
    ],
    [
      "an anonymous flood from one address",
      async () => {
        const codes = []
        for (let i = 0; i < 11; i++) codes.push(await send("GET", "/api/users/profile", "10.9.2.1"))
        return [codes[9], codes[10]]
      },
      [401, 429],
    ],
    [
      "strangers guessing at once stop at 10 tries an email, then even the right password waits",
      async () => {
        const sends = Array.from({ length: 15 }, (_, i) => {
          const email = i % 2 ? emails[2].toUpperCase() : emails[2]
          return send("POST", "/api/auth/signin", `10.9.5.${i}`, undefined, { email, password: "Wrong@1234" })
        })
        const guessed = (await Promise.all(sends)).filter((code) => code === 401).length
        return [guessed, await send("POST", "/api/auth/signin", "10.9.6.1", undefined, { email: emails[2], password: PASSWORD })]
      },
      [10, 429],
    ],
    [
      "a browser that signed in before still gets in while strangers guess",
      async () => {
        const signin = (remoteAddress: string, password: string, cookie?: string) =>
          app.inject({
            method: "POST",
            url: "/api/auth/signin",
            remoteAddress,
            headers: cookie ? { cookie } : {},
            payload: { email: emails[0], password },
          })
        const first = await signin("10.9.3.1", PASSWORD)
        const known = first.cookies.find((cookie) => cookie.name === "nerla_known")!
        for (let i = 0; i < 10; i++) await signin(`10.9.3.${i + 10}`, "Wrong@1234")
        const stranger = await signin("10.9.3.30", PASSWORD)
        const owner = await signin("10.9.3.31", PASSWORD, `nerla_known=${known.value}`)
        // The desktop app sends the same marks in a header
        for (let i = 0; i < 10; i++) await signin(`10.9.3.${i + 70}`, "Wrong@1234")
        const desktop = await app.inject({
          method: "POST",
          url: "/api/auth/signin",
          remoteAddress: "10.9.3.90",
          headers: { "x-nerla-known": known.value },
          payload: { email: emails[0], password: PASSWORD },
        })
        // A new password ends the mark, so the same browser waits like a stranger
        await db
          .update(users)
          .set({ passwordHash: await bcrypt.hash("New@12345", 4) })
          .where(eq(users.email, emails[0]))
        for (let i = 0; i < 10; i++) await signin(`10.9.3.${i + 40}`, "Wrong@1234")
        const afterReset = await signin("10.9.3.60", "New@12345", `nerla_known=${known.value}`)
        return [stranger.statusCode, owner.statusCode, desktop.statusCode, afterReset.statusCode]
      },
      [429, 200, 200, 429],
    ],
    [
      "a user's own sign-ins never use up the budget",
      async () => {
        const codes = []
        for (let i = 0; i < 11; i++)
          codes.push(await send("POST", "/api/auth/signin", `10.9.4.${i}`, undefined, { email: emails[1], password: PASSWORD }))
        return codes[10]
      },
      200,
    ],
  ])("%s", async (_name, run, expected) => {
    expect(await run()).toEqual(expected)
  })
})
