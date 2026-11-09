import { describe, expect, it } from "vitest"
import { cookieOriginAllowed } from "./authCookie"

describe("cookieOriginAllowed", () => {
  it("accepts an origin on the host the socket was opened on, and no other", () => {
    expect(cookieOriginAllowed("http://192.168.1.10:3001", "192.168.1.10:3001")).toBe(true)
    expect(cookieOriginAllowed("https://nerla.example", "nerla.example:443")).toBe(true)
    expect(cookieOriginAllowed("http://192.168.1.11:3001", "192.168.1.10:3001")).toBe(false)
    expect(cookieOriginAllowed("http://evil.example", "192.168.1.10:3001")).toBe(false)
    expect(cookieOriginAllowed(null, "192.168.1.10:3001")).toBe(false)
  })
})
