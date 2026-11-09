import { describe, expect, it } from "vitest"
import { GO_TO_WINDOW_MS, goToStep, letterOf } from "./shortcuts"

describe("goToStep", () => {
  it("goes to a page when a go-to letter follows G in time", () => {
    const armed = goToStep(null, "g", 1000)
    expect(armed).toEqual({ armedAt: 1000, goto: null })
    expect(goToStep(armed.armedAt, "a", 1000 + GO_TO_WINDOW_MS).goto?.path).toBe("/calendar")
    expect(goToStep(armed.armedAt, "H", 1500).goto?.path).toBe("/")
  })

  it("does nothing for a letter alone, a late letter or an unknown one", () => {
    expect(goToStep(null, "h", 1000).goto).toBeNull()
    expect(goToStep(1000, "h", 1001 + GO_TO_WINDOW_MS)).toEqual({ armedAt: null, goto: null })
    expect(goToStep(1000, "q", 1200)).toEqual({ armedAt: null, goto: null })
  })

  it("reads the letter from the key's place on other layouts", () => {
    expect(letterOf({ key: "п", code: "KeyG" })).toBe("g")
    expect(letterOf({ key: "H", code: "KeyH" })).toBe("h")
  })
})
