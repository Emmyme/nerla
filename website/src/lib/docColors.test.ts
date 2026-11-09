import { describe, expect, it } from "vitest"
import { DOC_COLORS, docColor } from "./docColors"

describe("docColor", () => {
  it("gives a user the same candy color every time", () => {
    const id = "4f6c1a52-9d1e-4f0b-8f43-0a9c3c2d7b11"
    expect(docColor(id)).toBe(docColor(id))
    expect(DOC_COLORS).toContain(docColor(id))
    expect(docColor(id)).toMatch(/^#[0-9A-F]{6}$/)
  })

  it("tells two users apart", () => {
    expect(docColor("4f6c1a52-9d1e-4f0b-8f43-0a9c3c2d7b11")).not.toBe(docColor("b2a8e7c0-3d55-4c1e-9a6f-2e7d1c0f9a33"))
  })
})
