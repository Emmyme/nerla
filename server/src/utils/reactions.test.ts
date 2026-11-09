import { describe, expect, it } from "vitest"
import { reactionBodySchema } from "../validation/schemas"

describe("reaction schemas", () => {
  it("takes only the known keys", () => {
    for (const key of ["thumbs-up", "cat", "cat-search", "cat-sleepy"])
      expect(reactionBodySchema.safeParse({ emoji: key }).success).toBe(true)
    expect(reactionBodySchema.safeParse({ emoji: "👍" }).success).toBe(false)
    expect(reactionBodySchema.safeParse({ emoji: "" }).success).toBe(false)
  })
})
