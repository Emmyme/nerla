import { describe, expect, it } from "vitest"
import { userProfilePutSchema } from "../validation/schemas"
import { ownProfile } from "./userProfile"

const row = (accessibility: unknown) => ({
  jobTitle: null,
  team: null,
  location: null,
  timeZone: null,
  pronouns: null,
  phone: null,
  workingHours: null,
  workBreaks: null,
  accessibility,
})

describe("accessibility settings", () => {
  it("come back as they were saved, and a stored row with stray values keeps only the known choices", () => {
    const sent = { typeShapes: true, reduceMotion: true, easierReading: false, largerText: true, moreContrast: true, stillZs: false }
    const body = userProfilePutSchema.parse({ accessibility: sent })
    expect(ownProfile(row(body.accessibility)).accessibility).toEqual(sent)
    expect(ownProfile(row(null)).accessibility).toEqual({ stillZs: true })
    expect(ownProfile(row({ reduceMotion: true, sparkles: true, moreContrast: "yes", largerText: 1 })).accessibility).toEqual({
      reduceMotion: true,
      stillZs: true,
    })
  })

  it("refuse unknown fields and values that are not yes or no", () => {
    expect(userProfilePutSchema.safeParse({ accessibility: { sparkles: true } }).success).toBe(false)
    expect(userProfilePutSchema.safeParse({ accessibility: { reduceMotion: "on" } }).success).toBe(false)
  })
})
