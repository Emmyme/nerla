import { describe, expect, it } from "vitest"
import { capToBytes } from "./storageCaps"

describe("capToBytes", () => {
  it("turns a GB or MB value into bytes", () => {
    expect(capToBytes("1.5", "GB")).toBe(1610612736)
    expect(capToBytes("1", "MB")).toBe(1048576)
    expect(capToBytes("1.", "MB")).toBe(1048576)
  })

  it("reads an empty field as no limit", () => {
    expect(capToBytes("", "GB")).toBeNull()
    expect(capToBytes("  ", "MB")).toBeNull()
  })
})
