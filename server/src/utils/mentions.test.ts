import { describe, expect, it } from "vitest"
import { addedAiMention, addedMentions, mentionsAi, parseMentions } from "./mentions"

describe("user mentions", () => {
  const a = "0b6f2a1e-3c4d-4e5f-8a9b-1c2d3e4f5a6b"
  const b = "7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f"

  it("reads each @[uuid] token once, in lowercase", () => {
    expect(parseMentions(`hi @[${a.toUpperCase()}] and @[${b}], again @[${a}], not @[nope] or @${a}`)).toEqual([a, b])
  })

  it("finds only the users an edit adds", () => {
    expect(addedMentions(`@[${a}]`, `@[${a}] @[${b}]`)).toEqual([b])
    expect(addedMentions(`@[${a}] @[${b}]`, `@[${a}]`)).toEqual([])
  })
})

describe("the AI mention", () => {
  it("is found and never taken for a user", () => {
    expect(mentionsAi("ask @[ai] now")).toBe(true)
    expect(parseMentions("ask @[ai] now")).toEqual([])
  })

  it("wakes an edit only when the edit adds it", () => {
    expect(addedAiMention("ask later", "ask @[AI] now")).toBe(true)
    expect(addedAiMention("ask @[ai]", "ask @[ai] again")).toBe(false)
    expect(addedAiMention("ask @[ai]", "ask")).toBe(false)
  })
})
