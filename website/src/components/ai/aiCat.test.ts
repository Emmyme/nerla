import { describe, expect, it } from "vitest"
import { catState } from "./aiCat"

describe("catState", () => {
  const idle = { windowOpen: false, running: false, waiting: false, endedAt: null, now: 10_000 }

  it("is awake while the window is open, a request runs or a card waits", () => {
    expect(catState({ ...idle, windowOpen: true })).toBe("awake")
    expect(catState({ ...idle, running: true })).toBe("awake")
    expect(catState({ ...idle, waiting: true })).toBe("awake")
  })

  it("falls asleep only 4 seconds after the last of them ends", () => {
    expect(catState(idle)).toBe("asleep")
    expect(catState({ ...idle, endedAt: 7_000 })).toBe("awake")
    expect(catState({ ...idle, endedAt: 6_000 })).toBe("asleep")
  })
})
