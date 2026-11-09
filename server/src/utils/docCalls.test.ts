import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { docsForEventQuerySchema } from "../validation/schemas"
import { callGuestClaims, eventDay, guestDocClaims, signCallGuestPass, signGuestDocToken } from "./docCalls"

const SECRET = "a-test-secret-that-is-long-enough-for-hs256-signing"
const claims = {
  shareId: "11111111-1111-4111-8111-111111111111",
  fileId: "22222222-2222-4222-8222-222222222222",
  identity: "guest-33333333-3333-4333-8333-333333333333",
  name: "Ada (Guest)",
}
const now = new Date("2026-10-28T12:00:00Z")

/** A token shaped like the real one, with any payload and secret */
function forged(payload: object, secret: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}`
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`
}

describe("guestDocClaims", () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.JWT_SECRET
    process.env.JWT_SECRET = SECRET
  })
  afterEach(() => {
    process.env.JWT_SECRET = saved
  })

  it("accepts a fresh token", () => {
    const { token } = signGuestDocToken(claims, now)
    expect(guestDocClaims(token, new Date(now.getTime() + 60_000))).toEqual(claims)
  })

  it("rejects another secret, another typ and a token expired by a second", () => {
    const iat = Math.floor(now.getTime() / 1000)
    expect(
      guestDocClaims(forged({ typ: "doc-guest", ...claims, iat, exp: iat + 600 }, "some-other-secret-of-the-same-length-or-so"), now),
    ).toBeNull()
    expect(guestDocClaims(forged({ typ: "member", ...claims, iat, exp: iat + 600 }, SECRET), now)).toBeNull()
    const { token, expiresAt } = signGuestDocToken(claims, now)
    expect(guestDocClaims(token, new Date(expiresAt.getTime() + 1000))).toBeNull()
  })
})

describe("callGuestClaims", () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.JWT_SECRET
    process.env.JWT_SECRET = SECRET
  })
  afterEach(() => {
    process.env.JWT_SECRET = saved
  })

  it("accepts a fresh pass and rejects a doc token, another secret and an expired pass", () => {
    const pass = { roomName: "meeting-44444444-4444-4444-8444-444444444444", identity: claims.identity, name: claims.name }
    const { token, expiresAt } = signCallGuestPass(pass, now)
    expect(callGuestClaims(token, now)).toEqual(pass)
    expect(callGuestClaims(signGuestDocToken(claims, now).token, now)).toBeNull()
    expect(guestDocClaims(token, now)).toBeNull()
    const iat = Math.floor(now.getTime() / 1000)
    expect(
      callGuestClaims(forged({ typ: "call-guest", ...pass, iat, exp: iat + 600 }, "some-other-secret-of-the-same-length-or-so"), now),
    ).toBeNull()
    expect(callGuestClaims(token, new Date(expiresAt.getTime() + 1000))).toBeNull()
  })
})

describe("for-event day", () => {
  it("reads a start in the event's zone and takes exactly one of date or start", () => {
    expect(eventDay({ start: "2026-10-27T23:30:00Z" }, "Europe/Stockholm")).toBe("2026-10-28")
    expect(eventDay({ start: "2026-10-27T23:30:00Z" }, "America/New_York")).toBe("2026-10-27")
    expect(eventDay({ date: "2026-10-27" }, "Europe/Stockholm")).toBe("2026-10-27")
    expect(docsForEventQuerySchema.safeParse({ start: "2026-10-27T23:30:00Z" }).success).toBe(true)
    expect(docsForEventQuerySchema.safeParse({ date: "2026-10-27" }).success).toBe(true)
    expect(docsForEventQuerySchema.safeParse({ date: "2026-10-27", start: "2026-10-27T23:30:00Z" }).success).toBe(false)
    expect(docsForEventQuerySchema.safeParse({}).success).toBe(false)
  })
})
