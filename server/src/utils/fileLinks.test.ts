import { describe, expect, it } from "vitest"
import { expiryDate, isStaleAvatar, linkState, newLinkToken, shouldPurge } from "./fileLinks"

const NOW = new Date("2026-10-26T12:00:00Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const live = { deletedAt: null, ownerRemovedAt: null }
const row = (set: Partial<Parameters<typeof shouldPurge>[0]> = {}): Parameters<typeof shouldPurge>[0] => ({
  deletedAt: null,
  isDraft: false,
  createdAt: ago(400 * DAY),
  projectId: null,
  ownerRemovedAt: null,
  ownerRejoinUntil: null,
  ...set,
})

describe("expiryDate", () => {
  it("adds the chosen days, and never has no date", () => {
    expect(expiryDate("7d", NOW)).toBe("2026-11-02T12:00:00.000Z")
    expect(expiryDate("never", NOW)).toBeNull()
  })
})

describe("newLinkToken", () => {
  it("is 32 random bytes in base64url", () => {
    const token = newLinkToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newLinkToken()).not.toBe(token)
  })
})

describe("linkState", () => {
  it("expires one millisecond after its expiry", () => {
    const link = { expiresAt: NOW.toISOString(), revokedAt: null }
    expect(linkState(link, live, new Date(NOW.getTime() + 1))).toBe("expired")
  })

  it("is revoked once turned off", () => {
    expect(linkState({ expiresAt: null, revokedAt: ago(MINUTE) }, live, NOW)).toBe("revoked")
  })

  it("is gone for a trashed file or a removed owner", () => {
    const link = { expiresAt: null, revokedAt: null }
    expect(linkState(link, { deletedAt: ago(MINUTE), ownerRemovedAt: null }, NOW)).toBe("gone")
    expect(linkState(link, { deletedAt: null, ownerRemovedAt: ago(MINUTE) }, NOW)).toBe("gone")
    expect(linkState(link, null, NOW)).toBe("gone")
  })

  it("is active otherwise", () => {
    expect(linkState({ expiresAt: new Date(NOW.getTime() + DAY).toISOString(), revokedAt: null }, live, NOW)).toBe("active")
    expect(linkState({ expiresAt: null, revokedAt: null }, live, NOW)).toBe("active")
  })
})

describe("shouldPurge", () => {
  it("purges Trash after 30 days", () => {
    expect(shouldPurge(row({ deletedAt: ago(30 * DAY + MINUTE) }), NOW)).toBe(true)
    expect(shouldPurge(row({ deletedAt: ago(29 * DAY) }), NOW)).toBe(false)
  })

  it("purges a draft after a day", () => {
    expect(shouldPurge(row({ isDraft: true, createdAt: ago(25 * HOUR) }), NOW)).toBe(true)
  })

  it("keeps a removed owner's project file", () => {
    expect(shouldPurge(row({ projectId: "p", ownerRemovedAt: ago(40 * DAY) }), NOW)).toBe(false)
  })

  it("keeps a removed owner's files while a rejoin is pending", () => {
    const rejoin = new Date(NOW.getTime() + 3 * DAY).toISOString()
    expect(shouldPurge(row({ ownerRemovedAt: ago(31 * DAY), ownerRejoinUntil: rejoin }), NOW)).toBe(false)
  })

  it("purges a removed owner's own file after 30 days", () => {
    expect(shouldPurge(row({ ownerRemovedAt: ago(31 * DAY) }), NOW)).toBe(true)
  })
})

describe("isStaleAvatar", () => {
  it("purges an avatar nobody uses after a day, never a user's current one", () => {
    expect(isStaleAvatar({ createdAt: ago(25 * HOUR), referenced: false }, NOW)).toBe(true)
    expect(isStaleAvatar({ createdAt: ago(25 * HOUR), referenced: true }, NOW)).toBe(false)
  })
})
