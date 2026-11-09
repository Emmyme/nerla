import { describe, expect, it } from "vitest"
import { SYMBOL_KEYS as SERVER_KEYS } from "../../../../server/src/utils/symbols"
import { SYMBOLS, symbolFor } from "./symbols"

describe("symbols", () => {
  it("has one entry for every key the server accepts, in the same order", () => {
    expect(SYMBOLS.map((entry) => entry.key)).toEqual([...SERVER_KEYS])
  })

  it("gives each symbol its own icon and label", () => {
    expect(new Set(SYMBOLS.map((entry) => entry.Icon)).size).toBe(SYMBOLS.length)
    expect(new Set(SYMBOLS.map((entry) => entry.label)).size).toBe(SYMBOLS.length)
  })

  it("finds nothing for null or an unknown key", () => {
    expect(symbolFor("butterfly")?.label).toBe("Butterfly")
    expect(symbolFor(null)).toBeUndefined()
    expect(symbolFor("unicorn")).toBeUndefined()
  })
})
