import { describe, expect, it } from "vitest"
import { availabilityChangesAt, availabilityOf, type AvailabilityEvent, type WorkingHours } from "./availability"

const at = (iso: string) => Date.parse(iso)
const event = (fields: Partial<AvailabilityEvent> & Pick<AvailabilityEvent, "startMs" | "endMs">): AvailabilityEvent => ({
  allDay: false,
  eventType: "meeting",
  title: "Planning",
  visibility: "full",
  ...fields,
})
const WEEK: WorkingHours = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((day) => [day, { start: "09:00", end: "17:00" }]))
const STOCKHOLM = "Europe/Stockholm"

describe("availabilityOf", () => {
  const meeting = event({ startMs: at("2026-10-27T13:00:00Z"), endMs: at("2026-10-27T14:00:00Z") })
  const ooo = event({ eventType: "ooo", title: "Dentist", startMs: at("2026-10-27T12:00:00Z"), endMs: at("2026-10-27T16:00:00Z") })

  it("puts out of office first, then busy, then outside working hours", () => {
    const now = at("2026-10-27T13:30:00Z")
    const base = { nowMs: now, workingHours: WEEK, timeZone: STOCKHOLM }
    expect(availabilityOf({ ...base, events: [meeting, ooo] })).toEqual({ kind: "ooo", until: "2026-10-27T16:00:00.000Z", note: "Dentist" })
    expect(availabilityOf({ ...base, events: [meeting] })).toEqual({ kind: "meeting", until: "2026-10-27T14:00:00.000Z" })
    expect(availabilityOf({ ...base, events: [{ ...meeting, visibility: "busy" }] })).toEqual({
      kind: "busy",
      until: "2026-10-27T14:00:00.000Z",
    })
    expect(availabilityOf({ ...base, events: [{ ...meeting, eventType: "focus" }] }).kind).toBe("focus")
    expect(availabilityOf({ ...base, events: [{ ...meeting, visibility: "hidden" }] })).toEqual({ kind: null })
    expect(availabilityOf({ ...base, nowMs: at("2026-10-27T18:00:00Z"), events: [] })).toEqual({
      kind: "off_hours",
      until: "2026-10-28T08:00:00.000Z",
    })
  })

  it("keeps the title of an out of office the viewer may not see in full", () => {
    const now = at("2026-10-27T13:30:00Z")
    expect(availabilityOf({ nowMs: now, events: [{ ...ooo, visibility: "busy" }], workingHours: null, timeZone: null })).toEqual({
      kind: "ooo",
      until: "2026-10-27T16:00:00.000Z",
    })
  })

  it("reads an all-day out of office over several days in the user's zone, until its last day", () => {
    const trip = event({
      eventType: "ooo",
      title: "Trip",
      allDay: true,
      startMs: at("2026-10-27T00:00:00Z"),
      endMs: at("2026-11-01T00:00:00Z"),
    })
    const base = { events: [trip], workingHours: null, timeZone: "Pacific/Auckland" }
    expect(availabilityOf({ ...base, nowMs: at("2026-10-29T10:00:00Z") })).toEqual({ kind: "ooo", until: "2026-10-31", note: "Trip" })
    // 26 October 12:00 UTC is already the 27th in Auckland
    expect(availabilityOf({ ...base, nowMs: at("2026-10-26T12:00:00Z") }).kind).toBe("ooo")
    expect(availabilityOf({ ...base, timeZone: "America/Los_Angeles", nowMs: at("2026-10-27T05:00:00Z") }).kind).toBe(null)
    expect(availabilityOf({ ...base, nowMs: at("2026-10-31T12:00:00Z") }).kind).toBe(null)
  })

  it("finds the next working start across a daylight saving change", () => {
    // Stockholm moves to summer time on Sunday 29 March 2026, so Monday 09:00 is 07:00 UTC
    expect(availabilityOf({ nowMs: at("2026-03-27T17:00:00Z"), events: [], workingHours: WEEK, timeZone: STOCKHOLM })).toEqual({
      kind: "off_hours",
      until: "2026-03-30T07:00:00.000Z",
    })
    // And back on Sunday 25 October 2026, so Monday 09:00 is 08:00 UTC
    expect(availabilityOf({ nowMs: at("2026-10-23T16:00:00Z"), events: [], workingHours: WEEK, timeZone: STOCKHOLM }).until).toBe(
      "2026-10-26T08:00:00.000Z",
    )
    expect(availabilityOf({ nowMs: at("2026-03-09T12:00:00Z"), events: [], workingHours: WEEK, timeZone: "America/New_York" })).toEqual({
      kind: "off_hours",
      until: "2026-03-09T13:00:00.000Z",
    })
    expect(availabilityOf({ nowMs: at("2026-10-27T10:00:00Z"), events: [], workingHours: WEEK, timeZone: STOCKHOLM })).toEqual({
      kind: null,
    })
  })
})

describe("availabilityChangesAt", () => {
  it("is the next start or end of an event that counts, or the next working hours edge", () => {
    const base = { workingHours: WEEK, timeZone: STOCKHOLM }
    const later = event({ startMs: at("2026-10-27T13:00:00Z"), endMs: at("2026-10-27T14:00:00Z") })
    // Tuesday 10:30 in Stockholm, inside working hours that end at 16:00 UTC
    expect(availabilityChangesAt({ ...base, nowMs: at("2026-10-27T09:30:00Z"), events: [later] })).toBe(at("2026-10-27T13:00:00Z"))
    expect(availabilityChangesAt({ ...base, nowMs: at("2026-10-27T13:30:00Z"), events: [later] })).toBe(at("2026-10-27T14:00:00Z"))
    expect(availabilityChangesAt({ ...base, nowMs: at("2026-10-27T09:30:00Z"), events: [{ ...later, visibility: "hidden" }] })).toBe(
      at("2026-10-27T16:00:00Z"),
    )
    expect(availabilityChangesAt({ nowMs: at("2026-10-27T09:30:00Z"), events: [], workingHours: null, timeZone: null })).toBeUndefined()
  })
})
