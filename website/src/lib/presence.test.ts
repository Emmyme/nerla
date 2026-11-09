import { describe, expect, it } from "vitest"
import { presenceState, presenceText, type PresenceInfo } from "./presence"

const now = new Date("2026-10-27T13:30:00Z")
const later = "2026-10-27T14:00:00Z"
const online: PresenceInfo = { online: true, idle: false, inCall: false, availability: { kind: null } }

describe("presenceState", () => {
  it("puts out of office first, then busy, then away, then available", () => {
    const ooo = { kind: "ooo", until: "2026-10-30" } as const
    const meeting = { kind: "meeting", until: later } as const
    expect(presenceState({ ...online, idle: true, inCall: true, availability: ooo }, now)).toBe("ooo")
    expect(presenceState({ ...online, idle: true, availability: meeting }, now)).toBe("busy")
    expect(presenceState({ ...online, idle: true, inCall: true }, now)).toBe("busy")
    expect(presenceState({ ...online, idle: true, availability: { kind: "off_hours", until: later } }, now)).toBe("away")
    expect(presenceState(online, now)).toBe("available")
  })

  it("is offline without a connection, unless out of office", () => {
    const offline = { ...online, online: false }
    expect(presenceState({ ...offline, availability: { kind: "busy", until: later } }, now)).toBe("offline")
    expect(presenceState(offline, now)).toBe("offline")
    expect(presenceState({ ...offline, availability: { kind: "ooo", until: later } }, now)).toBe("ooo")
  })

  it("ignores a calendar state that has already ended", () => {
    expect(presenceState({ ...online, availability: { kind: "meeting", until: "2026-10-27T13:00:00Z" } }, now)).toBe("available")
  })
})

describe("a chosen status", () => {
  const ooo = { kind: "ooo", until: "2026-10-30" } as const

  it("wins over everything while it lasts, out of office and a call included", () => {
    expect(presenceState({ ...online, inCall: true, availability: ooo, status: { value: "available", until: null } }, now)).toBe(
      "available",
    )
    expect(presenceState({ ...online, status: { value: "dnd", until: later } }, now)).toBe("dnd")
  })

  it("shows offline while signed out, or out of office when the calendar says so", () => {
    const signedOut = { ...online, online: false }
    for (const value of ["available", "busy", "dnd", "away", "offline"] as const) {
      expect(presenceState({ ...signedOut, status: { value, until: null } }, now)).toBe("offline")
      expect(presenceState({ ...signedOut, availability: ooo, status: { value, until: null } }, now)).toBe("ooo")
    }
    expect(presenceText({ ...signedOut, status: { value: "dnd", until: later } }, now, "Europe/Stockholm")).toBe("Offline")
  })

  it("counts as automatic once it has ended", () => {
    expect(presenceState({ ...online, inCall: true, status: { value: "away", until: "2026-10-27T13:00:00Z" } }, now)).toBe("busy")
  })

  it("hides appear offline from others but not from yourself", () => {
    // Others get no choice and no live state, the user gets both
    expect(presenceState({ ...online, online: false }, now)).toBe("offline")
    const mine: PresenceInfo = { ...online, status: { value: "offline", until: null } }
    expect(presenceState(mine, now)).toBe("offline")
    expect(presenceText(mine, now, "Europe/Stockholm")).toBe("Appear offline")
    expect(presenceText({ ...online, online: false }, now, "Europe/Stockholm")).toBe("Offline")
  })

  it("keeps a secret, with nothing else in the tooltip", () => {
    const secret: PresenceInfo = { ...online, online: false, availability: ooo, status: { value: "secret", until: null } }
    expect(presenceState(secret, now)).toBe("secret")
    expect(presenceText(secret, now, "Europe/Stockholm")).toBe("That's a secret")
  })

  it("says how long do not disturb lasts", () => {
    expect(presenceText({ ...online, status: { value: "dnd", until: later } }, now, "Europe/Stockholm")).toBe("Do not disturb until 15:00")
    expect(presenceText({ ...online, status: { value: "dnd", until: null } }, now, "Europe/Stockholm")).toBe("Do not disturb")
  })
})

describe("presenceText", () => {
  it("adds outside working hours under the live state", () => {
    const info: PresenceInfo = { ...online, idle: true, availability: { kind: "off_hours", until: "2026-10-28T08:00:00Z" } }
    expect(presenceText(info, now, "Europe/Stockholm")).toBe("Away\nOutside working hours, back Wed 09:00")
    expect(presenceText({ ...online, inCall: true }, now, "Europe/Stockholm")).toBe("Busy, in a call")
  })
})
