import { describe, expect, it } from "vitest"
import { rovingIndex } from "./rovingFocus"

describe("rovingIndex", () => {
  it("moves along the row and wraps at both ends", () => {
    expect(rovingIndex("ArrowRight", 0, 3)).toBe(1)
    expect(rovingIndex("ArrowRight", 2, 3)).toBe(0)
    expect(rovingIndex("ArrowLeft", 0, 3)).toBe(2)
    expect(rovingIndex("ArrowLeft", 2, 3)).toBe(1)
  })

  it("jumps to the first and last with Home and End", () => {
    expect(rovingIndex("Home", 2, 3)).toBe(0)
    expect(rovingIndex("End", 0, 3)).toBe(2)
  })

  it("leaves every other key, and an empty row, alone", () => {
    expect(rovingIndex("ArrowDown", 1, 3)).toBeNull()
    expect(rovingIndex("Tab", 1, 3)).toBeNull()
    expect(rovingIndex("ArrowRight", 0, 0)).toBeNull()
  })

  it("moves a vertical list with Up and Down, and leaves Left and Right alone", () => {
    expect(rovingIndex("ArrowDown", 2, 3, "vertical")).toBe(0)
    expect(rovingIndex("ArrowUp", 0, 3, "vertical")).toBe(2)
    expect(rovingIndex("End", 0, 3, "vertical")).toBe(2)
    expect(rovingIndex("ArrowRight", 0, 3, "vertical")).toBeNull()
  })
})
