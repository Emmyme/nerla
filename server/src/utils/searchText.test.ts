import { describe, expect, it } from "vitest"
import { eventMatchable, parseTaskId, snippetAround } from "./searchText"

describe("parseTaskId", () => {
  it("reads a key and number, uppercasing the key", () => {
    expect(parseTaskId("web-142")).toEqual({ key: "WEB", number: 142 })
    expect(parseTaskId("A1-7")).toEqual({ key: "A1", number: 7 })
  })

  it("refuses anything that is not shaped like an ID", () => {
    expect(parseTaskId("142")).toBeNull()
    expect(parseTaskId("WEB-")).toBeNull()
    expect(parseTaskId("TOOLONGKEY-1")).toBeNull()
    expect(parseTaskId("1WEB-2")).toBeNull()
    expect(parseTaskId("WEB-99999999999")).toBeNull()
  })
})

describe("snippetAround", () => {
  const long = `${"a".repeat(200)} needle ${"b".repeat(200)}`

  it("keeps the match visible and trims both sides", () => {
    const snippet = snippetAround(long, "NEEDLE")
    expect(snippet).toContain("needle")
    expect(snippet.startsWith("…")).toBe(true)
    expect(snippet.endsWith("…")).toBe(true)
    expect(Array.from(snippet).length).toBeLessThanOrEqual(82)
  })

  it("leaves short text whole and folds whitespace", () => {
    expect(snippetAround("hello\n\n  there", "there")).toBe("hello there")
  })

  it("never splits a surrogate pair", () => {
    const text = `${"😀".repeat(100)}needle${"😀".repeat(100)}`
    const snippet = snippetAround(text, "needle", 20)
    expect(snippet).toContain("needle")
    expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})

describe("eventMatchable", () => {
  it("matches only events seen in full", () => {
    expect(eventMatchable("full")).toBe(true)
    expect(eventMatchable("busy")).toBe(false)
    expect(eventMatchable("hidden")).toBe(false)
  })
})
