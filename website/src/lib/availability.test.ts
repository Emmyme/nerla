import { describe, expect, it } from "vitest"
import { availabilityText } from "@/lib/availability"

// Tuesday 27 October 2026, 13:30 in Stockholm
const now = new Date("2026-10-27T12:30:00Z")
const text = (availability: Parameters<typeof availabilityText>[0], zone = "Europe/Stockholm") =>
  availabilityText(availability, now, zone, "en-GB")

describe("availabilityText", () => {
  it("says what a busy user is doing until when, in the viewer's time", () => {
    expect(text({ kind: "meeting", until: "2026-10-27T14:00:00.000Z" })).toBe("Busy, in a meeting until 15:00")
    expect(text({ kind: "focus", until: "2026-10-27T14:00:00.000Z" })).toBe("Busy, focusing until 15:00")
    expect(text({ kind: "busy", until: "2026-10-27T14:00:00.000Z" }, "America/New_York")).toBe("Busy until 10:00")
  })

  it("gives the last day of an out of office, with its title on a second line", () => {
    expect(text({ kind: "ooo", until: "2026-10-30", note: "Skiing" })).toBe("Out of office until Fri 30 Oct\nSkiing")
    expect(text({ kind: "ooo", until: "2026-10-27" })).toBe("Out of office today")
    expect(text({ kind: "ooo", until: "2026-10-27T15:00:00.000Z" })).toBe("Out of office until 16:00")
  })

  it("says when a user outside working hours is back", () => {
    expect(text({ kind: "off_hours", until: "2026-11-02T08:00:00.000Z" })).toBe("Outside working hours, back Mon 09:00")
    expect(text({ kind: "off_hours", until: "2026-10-27T13:00:00.000Z" })).toBe("Outside working hours, back at 14:00")
  })

  it("says nothing for no state or one that has ended", () => {
    expect(text({ kind: null })).toBeNull()
    expect(text({ kind: "meeting", until: "2026-10-27T12:00:00.000Z" })).toBeNull()
    expect(text({ kind: "ooo", until: "2026-10-26" })).toBeNull()
  })
})
