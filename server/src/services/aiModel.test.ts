import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ModelUnreachable, streamChat } from "./aiModel"

vi.mock("../db", () => ({ db: {}, aiUsage: {}, aiSettings: {}, aiPersonal: {}, fileAttachments: {} }))

let server: Server
let port: number

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(302, { Location: "http://169.254.169.254/" })
    res.end("secret-redirect-body")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe("streamChat", () => {
  it("treats a redirect as unreachable and says nothing about the response", async () => {
    const choice = { baseUrl: `http://127.0.0.1:${port}/v1`, model: "m", key: null, local: true, personal: false }
    const run = async () => {
      for await (const event of streamChat(choice, [{ role: "user", content: "hi" }], [], new AbortController().signal)) void event
    }
    const error = await run().then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ModelUnreachable)
    expect((error as Error).message).toBe("Couldn't connect")
  })
})
