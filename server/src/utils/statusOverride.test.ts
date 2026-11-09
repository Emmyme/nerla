import { describe, expect, it } from "vitest"
import { activeStatus, availabilityShown, loadedStatusApplies, presenceSeenBy, statusExpired, statusRetryMs } from "./statusOverride"

const now = Date.parse("2026-10-27T13:30:00Z")
const live = { online: true, idle: false, inCall: true }

describe("activeStatus", () => {
  it("keeps a choice until it ends, then counts as automatic", () => {
    expect(activeStatus("dnd", new Date("2026-10-27T15:00:00Z"), now)).toEqual({ value: "dnd", until: "2026-10-27T15:00:00.000Z" })
    expect(activeStatus("busy", null, now)).toEqual({ value: "busy", until: null })
    expect(activeStatus("dnd", new Date("2026-10-27T13:00:00Z"), now)).toBeNull()
    expect(activeStatus("sleeping", null, now)).toBeNull()
    expect(statusExpired("dnd", new Date("2026-10-27T13:00:00Z"), now)).toBe(true)
    expect(statusExpired("dnd", null, now)).toBe(false)
  })
})

describe("presenceSeenBy", () => {
  it("hides appear offline from others but not from the user", () => {
    const offline = { value: "offline", until: null } as const
    expect(presenceSeenBy(live, offline, false)).toEqual({ online: false, idle: false, inCall: false, status: null })
    expect(presenceSeenBy(live, offline, true)).toEqual({ ...live, status: offline })
    expect(availabilityShown(live, offline, false)).toBe(true)
    expect(presenceSeenBy(live, { value: "busy", until: null }, false)).toEqual({ ...live, status: { value: "busy", until: null } })
  })

  it("shows others offline while the user is signed out, whatever they chose", () => {
    const away = { online: false, idle: false, inCall: false }
    for (const value of ["available", "busy", "dnd", "away", "offline", "secret"] as const) {
      expect(presenceSeenBy(away, { value, until: null }, false)).toEqual({ ...away, status: null })
      expect(availabilityShown(away, { value, until: null }, false)).toBe(true)
    }
  })

  it("shows others only that a secret is one", () => {
    const secret = { value: "secret", until: "2026-10-27T15:00:00.000Z" } as const
    expect(presenceSeenBy(live, secret, false)).toEqual({
      online: false,
      idle: false,
      inCall: false,
      status: { value: "secret", until: null },
    })
    expect(presenceSeenBy(live, secret, true)).toEqual({ ...live, status: secret })
    expect(availabilityShown(live, secret, false)).toBe(false)
    expect(availabilityShown(live, secret, true)).toBe(true)
  })
})

describe("loading a stored status", () => {
  it("drops a read that a newer change overtook, and retries a failed one with a growing wait", () => {
    expect(loadedStatusApplies(3, 3)).toBe(true)
    expect(loadedStatusApplies(3, 4)).toBe(false)
    expect([0, 1, 2, 10].map(statusRetryMs)).toEqual([500, 1000, 2000, 30_000])
  })
})
