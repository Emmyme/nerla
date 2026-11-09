import fastify from "fastify"
import { describe, expect, it } from "vitest"
import { resolveTrustProxy } from "./trustProxy"

async function ipSeen(trust: string, remoteAddress: string) {
  const app = fastify({ trustProxy: resolveTrustProxy(trust) })
  app.get("/", (request) => ({ ip: request.ip }))
  const response = await app.inject({ url: "/", remoteAddress, headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" } })
  await app.close()
  return response.json().ip
}

describe("resolveTrustProxy", () => {
  it("counts hops back from a proxy on a local network, and trusts no client that reached the server directly", async () => {
    expect(await ipSeen("1", "172.18.0.5")).toBe("198.51.100.7")
    expect(await ipSeen("true", "::ffff:172.18.0.5")).toBe("198.51.100.7")
    expect(await ipSeen("2", "172.18.0.5")).toBe("203.0.113.9")
    expect(await ipSeen("1", "198.51.100.200")).toBe("198.51.100.200")
    expect(await ipSeen("false", "172.18.0.5")).toBe("172.18.0.5")
    // Five servers start one after another, which outlasts the default timeout when the whole suite runs at once
  }, 30_000)

  it("passes proxy addresses through and refuses a value it can't read", () => {
    expect(resolveTrustProxy("10.0.0.2, 192.168.0.0/16, loopback")).toBe("10.0.0.2, 192.168.0.0/16, loopback")
    for (const bad of ["0", "1.5", "garbage"]) expect(() => resolveTrustProxy(bad)).toThrow(`TRUST_PROXY is "${bad}"`)
  })
})
