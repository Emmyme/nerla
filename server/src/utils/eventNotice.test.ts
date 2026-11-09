import { describe, expect, it } from "vitest"
import { eventChangeRecipients } from "./eventNotice"

const guests = [
  { userId: "a", response: "yes" },
  { userId: "b", response: "pending" },
  { userId: "c", response: "no" },
]

describe("eventChangeRecipients", () => {
  it("tells guests who haven't declined", () => {
    expect(eventChangeRecipients(guests, "a", false)).toEqual(["b"])
  })

  it("tells only the organiser about an Everyone event", () => {
    expect(eventChangeRecipients(guests, "a", true, "o")).toEqual(["o"])
    expect(eventChangeRecipients(guests, "o", true, "o")).toEqual([])
  })

  it("tells the organiser only when another user made the change", () => {
    expect(eventChangeRecipients(guests, "a", false, "o")).toEqual(["b", "o"])
    expect(eventChangeRecipients(guests, "o", false, "o")).toEqual(["a", "b"])
  })
})
