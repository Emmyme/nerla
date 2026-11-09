import { describe, expect, it } from "vitest"
import { deletedLine, leftLine } from "./trashText"

const DAY = 86_400_000

describe("trashText", () => {
  it("says when and by whom", () => {
    const now = new Date(2026, 10, 4, 15, 0)
    const deletedAt = new Date(2026, 10, 1, 9, 30).toISOString()
    expect(deletedLine({ deletedAt, deletedBy: { name: "Theo" } }, now)).toBe("Deleted 3 days ago by Theo")
    expect(deletedLine({ deletedAt, deletedBy: null }, now)).toBe("Deleted 3 days ago")
  })

  it("says how long is left", () => {
    const now = new Date(2026, 10, 4, 15, 0)
    expect(leftLine(new Date(now.getTime() + 27 * DAY).toISOString(), now)).toBe("Deleted for good in 27 days")
    expect(leftLine(new Date(now.getTime() + 6 * 3_600_000).toISOString(), now)).toBe("Deleted for good today")
  })
})
