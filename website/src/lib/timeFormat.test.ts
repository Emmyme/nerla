import { describe, expect, it } from "vitest"
import { formatMinutes, parseDuration } from "./timeFormat"

describe("formatMinutes", () => {
  it("shows hours and minutes, dropping the empty part", () => {
    expect(formatMinutes(90)).toBe("1h 30m")
    expect(formatMinutes(60)).toBe("1h")
    expect(formatMinutes(45)).toBe("45m")
    expect(formatMinutes(0)).toBe("0m")
  })
})

describe("parseDuration", () => {
  it("reads hours and minutes in the ways users type them", () => {
    for (const text of ["1h 30m", "1.5h", "1,5h", "1:30"]) expect(parseDuration(text)).toBe(90)
    expect(parseDuration("1h")).toBe(60)
    expect(parseDuration("45m")).toBe(45)
    expect(parseDuration("45")).toBe(45)
  })

  it("refuses text and nothing", () => {
    expect(parseDuration("abc")).toBeNull()
    expect(parseDuration("0")).toBeNull()
  })
})
