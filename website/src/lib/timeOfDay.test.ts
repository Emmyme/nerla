import { describe, expect, it } from "vitest"
import { durationText, parseTimeOfDay, stepTimeOfDay } from "./timeOfDay"

describe("parseTimeOfDay", () => {
  it("reads typed times on the 24 hour clock", () => {
    expect(parseTimeOfDay("930")).toBe("09:30")
    expect(parseTimeOfDay("14")).toBe("14:00")
    expect(parseTimeOfDay("9")).toBe("09:00")
    expect(parseTimeOfDay("0930")).toBe("09:30")
    expect(parseTimeOfDay("9:30")).toBe("09:30")
    expect(parseTimeOfDay("9.30")).toBe("09:30")
    expect(parseTimeOfDay(" 23:45 ")).toBe("23:45")
    expect(parseTimeOfDay("3pm")).toBe("15:00")
    expect(parseTimeOfDay("12:15 am")).toBe("00:15")
  })

  it("refuses times that do not exist", () => {
    expect(parseTimeOfDay("25:00")).toBeNull()
    expect(parseTimeOfDay("960")).toBeNull()
    expect(parseTimeOfDay("13pm")).toBeNull()
    expect(parseTimeOfDay("noon")).toBeNull()
    expect(parseTimeOfDay("")).toBeNull()
  })
})

describe("stepping and durations", () => {
  it("steps onto the grid and round the clock", () => {
    expect(stepTimeOfDay("09:07", 1, 15)).toBe("09:15")
    expect(stepTimeOfDay("09:07", -1, 15)).toBe("09:00")
    expect(stepTimeOfDay("23:45", 1, 15)).toBe("00:00")
    expect(durationText("13:45", "15:15")).toBe("1 h 30 min")
    expect(durationText("23:00", "00:30")).toBe("1 h 30 min")
  })
})
