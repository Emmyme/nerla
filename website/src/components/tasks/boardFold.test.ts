// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readBacklogOpen, saveBacklogOpen } from "./boardFold"

describe("boardFold", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it("starts folded", () => {
    expect(readBacklogOpen()).toBe(false)
  })

  it("remembers an open column", () => {
    saveBacklogOpen(true)
    expect(readBacklogOpen()).toBe(true)
    saveBacklogOpen(false)
    expect(readBacklogOpen()).toBe(false)
  })

  it("reads folded when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(readBacklogOpen()).toBe(false)
  })
})
