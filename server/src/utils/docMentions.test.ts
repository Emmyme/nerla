import { describe, expect, it } from "vitest"
import { mentionsToCheck, mentionsToRecord } from "./docMentions"

const ada = "11111111-1111-4111-8111-111111111111"
const bo = "22222222-2222-4222-8222-222222222222"

describe("mentionsToRecord", () => {
  it("tells a user mentioned before access at the first store after they get it", () => {
    const recorded = new Set<string>()
    const first = mentionsToRecord([ada, bo], recorded, new Set([bo]))
    expect(first).toEqual({ record: [bo], settled: [bo] })

    first.record.forEach((id) => recorded.add(id))
    const second = mentionsToRecord([ada], recorded, new Set([ada, bo]))
    expect(second).toEqual({ record: [ada], settled: [ada] })

    second.record.forEach((id) => recorded.add(id))
    expect(mentionsToRecord([ada, bo], recorded, new Set([ada, bo]))).toEqual({ record: [], settled: [ada, bo] })
  })
})

describe("mentionsToCheck", () => {
  it("leaves a store with no member behind it to the next store a member makes", () => {
    const state = { known: new Set<string>(), waiting: new Set<string>(), checkedAt: 0 }
    expect(mentionsToCheck([ada, bo], state, null, 1000)).toEqual([])
    expect(mentionsToCheck([ada, bo], state, bo, 2000)).toEqual([ada, bo])
  })
})
