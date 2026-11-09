import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { NoMasterKey, open, seal } from "./secretBox"

const KEY = "ab".repeat(32)

describe("secretBox", () => {
  const before = process.env.AI_MASTER_KEY
  beforeEach(() => {
    process.env.AI_MASTER_KEY = KEY
  })
  afterEach(() => {
    if (before === undefined) delete process.env.AI_MASTER_KEY
    else process.env.AI_MASTER_KEY = before
  })

  it("returns the text it sealed", () => {
    const sealed = seal("sk-test-1234")
    expect(sealed.startsWith("v1:")).toBe(true)
    expect(sealed).not.toContain("sk-test")
    expect(open(sealed)).toBe("sk-test-1234")
  })

  it("refuses data that was changed", () => {
    const [version, iv, tag, data] = seal("sk-test-1234").split(":")
    const changed = (data[0] === "A" ? "B" : "A") + data.slice(1)
    expect(() => open([version, iv, tag, changed].join(":"))).toThrow()
  })

  it("refuses a tag cut short", () => {
    const [version, iv, tag, data] = seal("sk-test-1234").split(":")
    const short = Buffer.from(tag, "base64").subarray(0, 8).toString("base64")
    expect(() => open([version, iv, short, data].join(":"))).toThrow()
  })

  it("needs the master key", () => {
    const sealed = seal("sk-test-1234")
    delete process.env.AI_MASTER_KEY
    expect(() => seal("x")).toThrow(NoMasterKey)
    expect(() => open(sealed)).toThrow(NoMasterKey)
  })
})
