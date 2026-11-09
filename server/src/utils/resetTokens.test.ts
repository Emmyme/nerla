import { afterEach, describe, expect, it } from "vitest"
import { generateResetToken, isResetTokenExpired, resetTokenMatches } from "./resetTokens"

describe("reset and invite tokens", () => {
  const zone = process.env.TZ
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  })

  it("are stored only as a hash, and match only the token that made it", () => {
    const { token, hash } = generateResetToken()
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toBe(token)
    expect(resetTokenMatches(token, hash)).toBe(true)
    expect(resetTokenMatches(generateResetToken().token, hash)).toBe(false)
    expect(resetTokenMatches(token, null)).toBe(false)
  })

  it("read a stored expiry without a zone as UTC, in a server zone ahead of UTC too", () => {
    process.env.TZ = "Pacific/Auckland"
    const stored = (fromNow: number) => new Date(Date.now() + fromNow).toISOString().replace("T", " ").replace("Z", "")
    expect(isResetTokenExpired(stored(60 * 60_000))).toBe(false)
    expect(isResetTokenExpired(stored(-60_000))).toBe(true)
    expect(isResetTokenExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false)
    expect(isResetTokenExpired(null)).toBe(true)
    expect(isResetTokenExpired("soon")).toBe(true)
  })
})
