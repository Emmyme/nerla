import { describe, expect, it } from "vitest"
import { nearestSwatch } from "./projectColors"

describe("nearestSwatch", () => {
  it("maps legacy project colors to the nearest hue family", () => {
    expect(nearestSwatch("#3b82f6").key).toMatch(/^sky/)
    expect(nearestSwatch("#ec4899").key).toMatch(/^bubblegum/)
    expect(nearestSwatch("#10b981").key).toMatch(/^pistachio/)
    expect(nearestSwatch("#BDF2DC").key).toBe("pistachio")
    expect(nearestSwatch("#7EDDB5").key).toBe("pistachio-deep")
    expect(nearestSwatch("#8b5cf6").key).toMatch(/^lavender/)
  })
})
