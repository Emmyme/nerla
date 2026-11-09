import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { allDayBounds, DAY_MS, fromWallClock, inWindow, readInstant, wallClock, writeInstant } from "./eventTime"

const ZONES = ["UTC", "Europe/Stockholm", "America/Los_Angeles"]

describe.each(ZONES)("with the process in %s", (zone) => {
  const previous = process.env.TZ
  beforeAll(() => {
    process.env.TZ = zone
  })
  afterAll(() => {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  })

  it("reads a stored wall time as UTC", () => {
    expect(readInstant("2026-10-23 09:00:00")).toBe("2026-10-23T09:00:00.000Z")
    expect(readInstant("2026-10-23 09:00:00.123456")).toBe("2026-10-23T09:00:00.123Z")
    expect(readInstant("2026-10-23T09:00:00.000Z")).toBe("2026-10-23T09:00:00.000Z")
    expect(readInstant(null)).toBeNull()
  })

  it("stores an instant as its UTC wall time", () => {
    expect(writeInstant("2026-10-23T09:00:00.000Z")).toBe("2026-10-23 09:00:00.000")
    expect(writeInstant("2026-10-23T11:00:00+02:00")).toBe("2026-10-23 09:00:00.000")
  })

  it("rejects a time without a zone", () => {
    expect(() => writeInstant("2026-10-23T09:00:00")).toThrow()
    expect(() => writeInstant("2026-02-30T09:00:00Z")).toThrow()
  })

  it("makes all-day bounds end exclusive at UTC midnight", () => {
    expect(allDayBounds("2026-10-23", "2026-10-24")).toEqual({
      starts_at: "2026-10-23T00:00:00.000Z",
      ends_at: "2026-10-25T00:00:00.000Z",
    })
    expect(() => allDayBounds("2026-10-24", "2026-10-23")).toThrow()
  })

  it("moves a wall time in the spring gap forward and picks the first of a repeated hour", () => {
    const gap = fromWallClock(Date.UTC(2027, 2, 28, 2, 30), "Europe/Stockholm")
    expect(new Date(gap).toISOString()).toBe("2027-03-28T01:30:00.000Z")
    expect(wallClock(gap, "Europe/Stockholm")).toBe(Date.UTC(2027, 2, 28, 3, 30))

    const repeated = fromWallClock(Date.UTC(2026, 9, 25, 2, 30), "Europe/Stockholm")
    expect(new Date(repeated).toISOString()).toBe("2026-10-25T00:30:00.000Z")
  })
})

describe("inWindow", () => {
  const ms = (iso: string) => Date.parse(iso)
  const day = (date: string) => [ms(`${date}T00:00:00Z`), ms(`${date}T00:00:00Z`) + DAY_MS] as const

  it("keeps an all-day date that a viewer in some zone sees in the window", () => {
    const stockholmMonday = { from: ms("2026-10-18T22:00:00Z"), to: ms("2026-10-19T22:00:00Z") }
    const losAngelesMonday = { from: ms("2026-10-19T07:00:00Z"), to: ms("2026-10-20T07:00:00Z") }
    for (const window of [stockholmMonday, losAngelesMonday]) {
      expect(inWindow(...day("2026-10-19"), true, window)).toBe(true)
    }
    expect(inWindow(...day("2026-10-21"), true, stockholmMonday)).toBe(false)
    expect(inWindow(...day("2026-10-17"), true, losAngelesMonday)).toBe(false)
  })

  it("keeps timed events that overlap, with an exclusive end", () => {
    const window = { from: ms("2026-10-19T00:00:00Z"), to: ms("2026-10-20T00:00:00Z") }
    expect(inWindow(ms("2026-10-18T22:00:00Z"), ms("2026-10-19T01:00:00Z"), false, window)).toBe(true)
    expect(inWindow(ms("2026-10-20T00:00:00Z"), ms("2026-10-20T01:00:00Z"), false, window)).toBe(false)
  })
})
