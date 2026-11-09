import { describe, expect, it } from "vitest"
import { guestOutcome } from "./guestFlow"

describe("guestOutcome", () => {
  it("reads the status body while the request is open", () => {
    expect(guestOutcome(200, { status: "pending" })).toBe("waiting")
    expect(guestOutcome(200, { status: "admitted", token: "t" })).toBe("admitted")
    expect(guestOutcome(200, { status: "denied" })).toBe("denied")
    expect(guestOutcome(200)).toBe("waiting")
  })

  it("sends a guest back to asking when the one-time token was already taken", () => {
    expect(guestOutcome(200, { status: "admitted" })).toBe("expired")
  })

  it("stops waiting on a request the guest's closed tab cancelled", () => {
    expect(guestOutcome(200, { status: "cancelled" })).toBe("expired")
  })

  it("treats a sent request as waiting", () => {
    expect(guestOutcome(201, undefined, "request")).toBe("waiting")
  })

  it("tells an expired request from a missing meeting", () => {
    expect(guestOutcome(404)).toBe("expired")
    expect(guestOutcome(404, undefined, "status")).toBe("expired")
    expect(guestOutcome(404, undefined, "request")).toBe("missing")
  })

  it("gives busy when rate limited", () => {
    expect(guestOutcome(429)).toBe("busy")
    expect(guestOutcome(429, undefined, "request")).toBe("busy")
  })

  it("keeps waiting through a passing server error", () => {
    expect(guestOutcome(500)).toBe("waiting")
    expect(guestOutcome(502)).toBe("waiting")
  })
})
