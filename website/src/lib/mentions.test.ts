import { describe, expect, it } from "vitest"
import { mentionedPeople, parseMentions, renderMentionText, toMentionTokens } from "@/lib/mentions"

const ANNA = "a0000000-0000-4000-8000-000000000001"
const BO = "b0000000-0000-4000-8000-000000000002"
const GONE = "c0000000-0000-4000-8000-000000000003"
const names = new Map([
  [ANNA, "Anna Berg"],
  [BO, "Bo"],
])

describe("mentions", () => {
  it("parses each user once, whatever the case", () => {
    expect(parseMentions(`@[${ANNA.toUpperCase()}] hi @[${BO}] and @[${ANNA}], not @[nope] or @${BO}`)).toEqual([ANNA, BO])
  })

  it("renders names, and anyone unknown as Someone", () => {
    expect(renderMentionText(`hi @[${ANNA}], @[${GONE}] and @[${BO}]!`, names)).toBe("hi @Anna Berg, @Someone and @Bo!")
  })

  it("round-trips several mentions, repeats and unknown users back to their tokens", () => {
    const stored = `@[${ANNA}] ask @[${GONE}] and @[${BO}], then @[${ANNA}] again`
    const shown = renderMentionText(stored, names)
    expect(shown).toBe("@Anna Berg ask @Someone and @Bo, then @Anna Berg again")
    expect(toMentionTokens(shown, mentionedPeople(stored, names))).toBe(`@[${ANNA}] ask @[${GONE}] and @[${BO}], then @[${ANNA}] again`)
    // A namesake picked by mistake, deleted, then the other picked: the most recent pick wins
    const twin = "d0000000-0000-4000-8000-000000000004"
    expect(
      toMentionTokens("hi @Anna Berg", [
        { id: ANNA, name: "Anna Berg" },
        { id: twin, name: "Anna Berg" },
      ]),
    ).toBe(`hi @[${twin}]`)
  })
})
