import { describe, expect, it } from "vitest"
import { hashToken, newToken, sameHash, TOKEN_PREFIX, tokenAllows } from "./tokenScopes"

const NOW = new Date(Date.UTC(2026, 9, 28, 12))
const token = (overrides: Partial<Parameters<typeof tokenAllows>[0]> = {}) => ({
  scopes: { tasks: "read" as const },
  readOnly: false,
  expiresAt: null,
  revokedAt: null,
  ...overrides,
})

describe("tokenAllows", () => {
  it("allows a read scope to read and refuses it a write", () => {
    expect(tokenAllows(token(), "tasks", false, NOW)).toBe(true)
    expect(tokenAllows(token(), "tasks", true, NOW)).toBe(false)
    expect(tokenAllows(token(), "papers", false, NOW)).toBe(false)
  })

  it("refuses every write while read only, even with a write scope", () => {
    expect(tokenAllows(token({ scopes: { tasks: "write" } }), "tasks", true, NOW)).toBe(true)
    const readOnly = token({ scopes: { tasks: "write" }, readOnly: true })
    expect(tokenAllows(readOnly, "tasks", true, NOW)).toBe(false)
    expect(tokenAllows(readOnly, "tasks", false, NOW)).toBe(true)
  })

  it("refuses once expired or revoked", () => {
    expect(tokenAllows(token({ expiresAt: "2026-10-28 11:59:59" }), "tasks", false, NOW)).toBe(false)
    expect(tokenAllows(token({ expiresAt: "2026-10-29 12:00:00" }), "tasks", false, NOW)).toBe(true)
    expect(tokenAllows(token({ revokedAt: "2026-10-27 09:00:00" }), "tasks", false, NOW)).toBe(false)
  })

  it("allows the people area with any area and refuses it with none", () => {
    expect(tokenAllows(token({ scopes: { calendar: "read" } }), "people", false, NOW)).toBe(true)
    expect(tokenAllows(token({ scopes: {} }), "people", false, NOW)).toBe(false)
    expect(tokenAllows(token({ scopes: { calendar: "write" } }), "people", true, NOW)).toBe(false)
  })
})

describe("newToken", () => {
  it("carries the prefix and is kept only as its hash, which matches it alone", () => {
    const made = newToken()
    expect(made.token.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(made.hash).toBe(hashToken(made.token))
    expect(made.last4).toBe(made.token.slice(-4))
    expect(sameHash(hashToken(made.token), made.hash)).toBe(true)
    expect(sameHash(hashToken(newToken().token), made.hash)).toBe(false)
    expect(sameHash("", "")).toBe(false)
  })
})
