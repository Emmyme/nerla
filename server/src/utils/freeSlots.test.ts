import { describe, expect, it } from "vitest"
import type { WorkingHours } from "./availability"
import { askerDay, busyOf, findSlots, type FreePerson, type Interval } from "./freeSlots"

const at = (iso: string) => Date.parse(iso)
const iso = (slot: Interval) => [new Date(slot.start).toISOString().slice(0, 16), new Date(slot.end).toISOString().slice(0, 16)]
const WEEK: WorkingHours = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((day) => [day, { start: "09:00", end: "17:00" }]))
const STOCKHOLM = "Europe/Stockholm"
const NEW_YORK = "America/New_York"

const person = (id: string, fields: Partial<FreePerson> = {}): FreePerson => ({ id, busy: [], hours: WEEK, timeZone: STOCKHOLM, ...fields })
const base = {
  askerZone: STOCKHOLM,
  day: askerDay(null)!,
  from: at("2026-11-02T08:00:00Z"),
  to: at("2026-11-07T00:00:00Z"),
  minutes: 60,
  now: at("2026-11-01T00:00:00Z"),
}

describe("findSlots", () => {
  it("finds the first hour both are free", () => {
    const theo = person("theo", { busy: [{ start: at("2026-11-02T08:00:00Z"), end: at("2026-11-02T09:30:00Z") }] })
    const [first] = findSlots({ ...base, people: [person("asker"), theo] })
    expect(iso(first)).toEqual(["2026-11-02T09:30", "2026-11-02T10:30"])
  })

  it("keeps to everyone's working hours across time zones", () => {
    const sara = person("sara", { timeZone: NEW_YORK })
    const monday = findSlots({ ...base, people: [person("asker"), sara] }).filter((slot) => slot.start < at("2026-11-03T00:00:00Z"))
    expect(monday.map((slot) => iso(slot)[0])).toEqual(["2026-11-02T14:00", "2026-11-02T15:00"])
    expect(monday.every((slot) => slot.end <= at("2026-11-02T16:00:00Z"))).toBe(true)
  })

  it("uses only working hours for a calendar not shared", () => {
    const [first] = findSlots({ ...base, people: [person("asker"), person("ada", { busy: null, hours: null, timeZone: null })] })
    expect(iso(first)[0]).toBe("2026-11-02T08:00")
  })

  it("starts on the quarter hour and never in the past", () => {
    const [first] = findSlots({ ...base, now: at("2026-11-02T08:07:00Z"), people: [person("asker")] })
    expect(iso(first)[0]).toBe("2026-11-02T08:15")
  })

  it("gives at most 2 a day and 5 in all", () => {
    const slots = findSlots({ ...base, people: [person("asker")] })
    expect(slots.map((slot) => iso(slot)[0].slice(0, 10))).toEqual(["2026-11-02", "2026-11-02", "2026-11-03", "2026-11-03", "2026-11-04"])
    expect(slots[1].start).toBeGreaterThanOrEqual(slots[0].end)
  })

  it("uses the asker's own hours unless times are given", () => {
    const early: WorkingHours = Object.fromEntries(Object.keys(WEEK).map((day) => [day, { start: "07:00", end: "15:00" }]))
    const asker = person("asker", { hours: early })
    const first = (day: ReturnType<typeof askerDay>) =>
      iso(findSlots({ ...base, from: at("2026-11-02T00:00:00Z"), day: day!, people: [asker] })[0])[0]
    expect(first(askerDay(early))).toBe("2026-11-02T06:00")
    expect(first(askerDay(early, "10:00"))).toBe("2026-11-02T09:00")
    expect(askerDay(early, undefined, "06:00")).toBeNull()
  })

  it("keeps clear of work breaks", () => {
    const busy = [{ start: at("2026-11-02T08:00:00Z"), end: at("2026-11-02T10:30:00Z") }]
    const asker = person("asker", { busy, breaks: [{ start: "12:00", end: "13:00" }] })
    const [first, second] = findSlots({ ...base, minutes: 90, people: [asker] })
    expect(iso(first)).toEqual(["2026-11-02T12:00", "2026-11-02T13:30"])
    expect(iso(second)[0]).toBe("2026-11-02T13:30")
  })
})

describe("busyOf", () => {
  it("lets an all-day out of office block the day", () => {
    const ooo = { starts_at: "2026-11-02T00:00:00.000Z", ends_at: "2026-11-03T00:00:00.000Z", all_day: true, ooo: true }
    const allDayMeeting = { ...ooo, ooo: undefined, event_type: "meeting" }
    expect(busyOf([ooo, allDayMeeting], STOCKHOLM).map(iso)).toEqual([["2026-11-01T23:00", "2026-11-02T23:00"]])

    const away = person("ada", { busy: null, ooo: busyOf([ooo], STOCKHOLM) })
    const [first] = findSlots({ ...base, people: [person("asker"), away] })
    expect(iso(first)[0].slice(0, 10)).toBe("2026-11-03")
  })
})
