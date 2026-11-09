import { describe, expect, it } from "vitest"
import { clearAfterOf, clearAt, defaultClearAfter } from "./statusChoice"

describe("clear after", () => {
  it("clears busy, do not disturb and a secret today, and keeps the rest", () => {
    expect(defaultClearAfter("busy")).toBe("today")
    expect(defaultClearAfter("dnd")).toBe("today")
    expect(defaultClearAfter("secret")).toBe("today")
    expect(defaultClearAfter("away")).toBe("never")
    expect(defaultClearAfter("offline")).toBe("never")
  })

  it("ends tonight at 23:59, on Sunday at 23:59, or after the minutes", () => {
    const now = new Date(2026, 9, 28, 13, 30)
    expect(clearAt("30m", now)).toBe(new Date(2026, 9, 28, 14, 0).toISOString())
    expect(clearAt("today", now)).toBe(new Date(2026, 9, 28, 23, 59).toISOString())
    expect(clearAt("week", now)).toBe(new Date(2026, 10, 1, 23, 59).toISOString())
    expect(clearAt("never", now)).toBeNull()
    expect(clearAfterOf(clearAt("today", now), now)).toBe("today")
    expect(clearAfterOf(clearAt("1h", now), now)).toBeNull()
  })
})
