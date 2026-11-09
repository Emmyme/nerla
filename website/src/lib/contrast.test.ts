import { describe, expect, it } from "vitest"
import { contrastRatio } from "@/lib/contrast"

describe("contrastRatio", () => {
  it.each([
    ["returns 21 for black on white", "#FFFFFF", "#000000", 21],
    ["accepts hex without a hash", "1F2433", "FCFCFE", 15.09],
    ["matches a known accent pair", "#FFFFFF", "#3574D4", 4.56],
  ])("%s", (_name, first, second, ratio) => {
    expect(contrastRatio(first, second)).toBeCloseTo(ratio, 1)
  })
})
