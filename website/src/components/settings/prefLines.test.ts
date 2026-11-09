import { describe, expect, it } from "vitest"
import { linesChanged } from "./prefLines"

describe("prefLines", () => {
  it("spots a change", () => {
    expect(linesChanged(["a"], ["a "])).toBe(false)
    expect(linesChanged(["a"], ["b"])).toBe(true)
  })
})
