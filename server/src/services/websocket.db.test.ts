import { setTimeout as sleep } from "node:timers/promises"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { live } from "../live/live"
import { signedIn, testApp } from "../test/app"
import { makeWorkspace } from "../test/factories"

let app: FastifyInstance
let adminId: string

type Socket = Awaited<ReturnType<FastifyInstance["injectWS"]>>

/** The close code the server answers with, or "open" when the socket is still up a moment later */
const closeOf = (ws: Socket) =>
  new Promise<number | "open">((resolve) => {
    ws.once("close", (code: number) => resolve(code))
    setTimeout(() => resolve("open"), 2000)
  })

beforeAll(async () => {
  app = await testApp()
  ;({ adminId } = await makeWorkspace())
})

afterAll(() => app.close())

describe("websocket frame size", () => {
  it("closes a stranger's frame over 4 KB before sign-in", async () => {
    const ws = await app.injectWS("/ws")
    const closed = closeOf(ws)
    ws.send(JSON.stringify({ type: "auth", token: "x".repeat(4097) }))
    expect(await closed).toBe(1009)
  })

  it("closes a signed-in frame over the cap", async () => {
    const ws = await app.injectWS("/ws")
    const signedInNow = new Promise((resolve) =>
      ws.on("message", (raw: Buffer) => JSON.parse(raw.toString()).type === "auth_success" && resolve(1)),
    )
    ws.send(JSON.stringify({ type: "auth", token: (await signedIn(app, adminId)).authorization.slice("Bearer ".length) }))
    await signedInNow
    const closed = closeOf(ws)
    ws.send(Buffer.alloc(16 * 1024 * 1024 + 1))
    expect(await closed).toBe(1009)
  })
})

/** How many of the admin's `user:` subscriptions are still open once the run is over */
async function leftSubscribed(run: () => Promise<void>): Promise<number> {
  let subscribed = 0
  const subscribe = live.subscribe.bind(live)
  const spy = vi.spyOn(live, "subscribe").mockImplementation((topic, handler) => {
    const leave = subscribe(topic, handler)
    if (topic !== `user:${adminId}`) return leave
    subscribed += 1
    return () => {
      subscribed -= 1
      leave()
    }
  })
  try {
    await run()
    return subscribed
  } finally {
    spy.mockRestore()
  }
}

/** Drops the socket, then gives a sign-in still in flight a moment to finish */
async function terminate(ws: Socket) {
  const closed = new Promise((resolve) => ws.once("close", resolve))
  ws.terminate()
  await closed
  await sleep(100)
}

describe("websocket sign-in", () => {
  it("leaves nothing subscribed for a socket that closes while it signs in", async () => {
    const token = (await signedIn(app, adminId)).authorization.slice("Bearer ".length)
    const left = await leftSubscribed(async () => {
      await terminate(await app.injectWS("/ws", { headers: { cookie: `nerla_jwt=${token}`, origin: "http://localhost:3001" } }))
    })
    expect(left).toBe(0)
  })

  it("subscribes once however many sign-in messages arrive together", async () => {
    const auth = JSON.stringify({ type: "auth", token: (await signedIn(app, adminId)).authorization.slice("Bearer ".length) })
    const left = await leftSubscribed(async () => {
      const ws = await app.injectWS("/ws")
      const signedInNow = new Promise((resolve) =>
        ws.on("message", (raw: Buffer) => JSON.parse(raw.toString()).type === "auth_success" && resolve(1)),
      )
      ws.send(auth)
      ws.send(auth)
      await signedInNow
      await terminate(ws)
    })
    expect(left).toBe(0)
  })
})
