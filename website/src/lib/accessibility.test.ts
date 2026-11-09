import { describe, expect, it } from "vitest"
import { ACCESSIBILITY_DEFAULTS, choicesOf, rootState } from "./accessibility"

describe("rootState", () => {
  it("holds still and raises contrast when either the device asks or the user turned it on", () => {
    const device = { reduceMotion: false, moreContrast: false }
    expect(rootState(ACCESSIBILITY_DEFAULTS, device)).toEqual({
      motion: "full",
      still: false,
      contrast: "normal",
      reading: "normal",
      text: "normal",
      zs: "still",
    })
    expect(rootState(ACCESSIBILITY_DEFAULTS, { reduceMotion: true, moreContrast: true })).toMatchObject({
      motion: "reduce",
      still: false,
      contrast: "more",
    })
    expect(
      rootState(
        { ...ACCESSIBILITY_DEFAULTS, reduceMotion: true, moreContrast: true, easierReading: true, largerText: true, stillZs: false },
        device,
      ),
    ).toEqual({
      motion: "reduce",
      still: true,
      contrast: "more",
      reading: "easier",
      text: "larger",
      zs: "moving",
    })
  })
})

describe("choicesOf", () => {
  it("reads a sleeping z choice never made as still, and everything else as off", () => {
    expect(choicesOf({})).toEqual({
      typeShapes: false,
      reduceMotion: false,
      easierReading: false,
      largerText: false,
      moreContrast: false,
      stillZs: true,
    })
    expect(choicesOf({ stillZs: false, sparkles: true }).stillZs).toBe(false)
  })
})
