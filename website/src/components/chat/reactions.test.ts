import { describe, expect, it } from "vitest"
import type { MessageReaction } from "@/lib/api/chat"
import { groupReactions, reactionFor } from "./reactions"

const r = (id: string, emoji: string, user_id: string): MessageReaction => ({ id, emoji, user_id })

describe("reactionFor", () => {
  it("finds a key, and nothing for a value outside the set", () => {
    expect(reactionFor("fire")?.label).toBe("Fire")
    expect(reactionFor("👍")).toBeUndefined()
  })
})

describe("groupReactions", () => {
  it("counts each user once per reaction and marks the user's own", () => {
    const list = [r("1", "thumbs-up", "hannah"), r("2", "thumbs-up", "bob"), r("3", "thumbs-up", "me"), r("4", "heart", "bob")]
    const groups = groupReactions(list, "me")
    expect(groups.map((g) => [g.key, g.people.length, g.mine])).toEqual([
      ["thumbs-up", 3, true],
      ["heart", 1, false],
    ])
  })
})
