import { describe, expect, it } from "vitest"
import { normalizeProfile, profileFor } from "./userProfile"

const ORG = "a0000000-0000-4000-8000-000000000001"
const OTHER = "b0000000-0000-4000-8000-000000000002"
const member = (organizationId: string, role = "member") => ({
  organizationId,
  role,
  user: {
    id: "u1",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    avatarUrl: null,
    jobTitle: "Frontend developer",
    team: null,
    location: null,
    timeZone: "Europe/London",
    pronouns: null,
    phone: null,
  },
})

describe("profileFor", () => {
  it("gives the card of a user in the same organization", () => {
    expect(profileFor(ORG, member(ORG, "admin"), { kind: "busy", until: "2026-10-25T15:00:00.000Z" })).toEqual({
      id: "u1",
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      avatar_url: null,
      role: "admin",
      job_title: "Frontend developer",
      team: null,
      location: null,
      time_zone: "Europe/London",
      pronouns: null,
      phone: null,
      availability: { kind: "busy", until: "2026-10-25T15:00:00.000Z" },
    })
  })

  it("gives nothing for a user in another organization, or for a viewer outside any", () => {
    expect(profileFor(ORG, member(OTHER))).toBeNull()
    expect(profileFor(null, member(ORG))).toBeNull()
    expect(profileFor(ORG, null)).toBeNull()
  })
})

describe("normalizeProfile", () => {
  it("trims values, stores empty ones as null and leaves omitted ones out", () => {
    expect(normalizeProfile({ jobTitle: "  Designer ", team: "   ", phone: null, timeZone: " Europe/Stockholm " })).toEqual({
      ok: true,
      values: { jobTitle: "Designer", team: null, phone: null, timeZone: "Europe/Stockholm" },
    })
  })

  it("refuses an unknown time zone and a value over its limit", () => {
    expect(normalizeProfile({ timeZone: "Mars/Olympus" }).ok).toBe(false)
    expect(normalizeProfile({ pronouns: "x".repeat(41) }).ok).toBe(false)
    expect(normalizeProfile({ jobTitle: ` ${"x".repeat(100)} ` }).ok).toBe(true)
  })

  it("keeps valid working hours and refuses a range that ends before it starts", () => {
    expect(normalizeProfile({ workingHours: { mon: { start: "09:00", end: "17:00" } } })).toEqual({
      ok: true,
      values: { workingHours: { mon: { start: "09:00", end: "17:00" } } },
    })
    expect(normalizeProfile({ workingHours: {} })).toEqual({ ok: true, values: { workingHours: null } })
    expect(normalizeProfile({ workingHours: { mon: { start: "17:00", end: "09:00" } } }).ok).toBe(false)
    expect(normalizeProfile({ workingHours: { xyz: { start: "09:00", end: "17:00" } } as never }).ok).toBe(false)
  })
})
