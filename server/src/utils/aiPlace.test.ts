import { describe, expect, it } from "vitest"
import { filterShared } from "./aiPlace"
import type { ItemRef } from "./aiTypes"

const task = (id: string) => ({ ref: { kind: "task", id } as ItemRef, title: id })

/** Theo can read everything, Sara can't read the task "private" */
const canRead = async (userId: string, ref: ItemRef) => !(userId === "sara" && ref.id === "private")

describe("filterShared", () => {
  it.each([
    ["keeps an item every audience member can read", ["open"], ["theo", "sara"], ["open"]],
    ["drops an item one member can't read", ["open", "private"], ["theo", "sara"], ["open"]],
    ["keeps nothing for an empty audience", ["open"], [], []],
  ])("%s", async (_name, items, audience, kept) => {
    expect(await filterShared(items.map(task), audience, canRead)).toEqual(kept.map(task))
  })
})
