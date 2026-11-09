import { describe, expect, it } from "vitest"
import { deriveProjectKey, formatTaskIdentifier } from "./taskKeys"

const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,4}$/

describe("deriveProjectKey", () => {
  it("uses the initials of up to three words", () => {
    expect(deriveProjectKey("Website Redesign", new Set())).toBe("WR")
    expect(deriveProjectKey("Infrastructure Migration Plan", new Set())).toBe("IMP")
  })

  it("uses the first three characters of a single word", () => {
    expect(deriveProjectKey("Analytics", new Set())).toBe("ANA")
  })

  it("appends a number when the key is taken", () => {
    expect(deriveProjectKey("Analytics", new Set(["ANA"]))).toBe("ANA2")
    expect(deriveProjectKey("Analytics", new Set(["ANA", "ANA2"]))).toBe("ANA3")
  })

  it("falls back to PRJ", () => {
    expect(deriveProjectKey("!!!", new Set())).toBe("PRJ")
  })

  it("only counts words that start with a letter", () => {
    expect(deriveProjectKey("3D Studio", new Set())).toBe("STU")
  })

  it("always returns a valid key", () => {
    const names = ["3D Studio", "x", "Q2 Marketing Campaign", "Översyn", "!!!", "Mobile App v2"]
    for (const name of names) {
      expect(deriveProjectKey(name, new Set())).toMatch(KEY_PATTERN)
    }
    const taken = new Set(["ANA", ...Array.from({ length: 150 }, (_, i) => `ANA${i + 2}`)])
    expect(deriveProjectKey("Analytics", taken)).toMatch(KEY_PATTERN)
  })
})

describe("formatTaskIdentifier", () => {
  it("joins the key and number", () => {
    expect(formatTaskIdentifier("WEB", 142)).toBe("WEB-142")
  })

  it("returns null when either part is missing", () => {
    expect(formatTaskIdentifier(null, 142)).toBeNull()
    expect(formatTaskIdentifier("WEB", null)).toBeNull()
  })
})
