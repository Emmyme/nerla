import { describe, expect, it } from "vitest"
import { AI_PER_HOUR, budgetState, SlidingCounter } from "./aiLimits"

const HOUR = 60 * 60 * 1000

describe("SlidingCounter", () => {
  it("allows the limit within the window and again once the first has aged out", () => {
    const counter = new SlidingCounter(AI_PER_HOUR, HOUR)
    const start = Date.UTC(2026, 9, 28)
    for (let i = 0; i < AI_PER_HOUR; i++) expect(counter.take("u1", start + i)).toBe(true)
    expect(counter.take("u1", start + 1000)).toBe(false)
    expect(counter.take("u2", start + 1000)).toBe(true)
    expect(counter.take("u1", start + 61 * 60 * 1000)).toBe(true)
  })
})

describe("budgetState", () => {
  it("is reached at the cap and ok without one", () => {
    expect(budgetState(1000, 1000)).toBe("reached")
    expect(budgetState(5, null)).toBe("ok")
  })
})
