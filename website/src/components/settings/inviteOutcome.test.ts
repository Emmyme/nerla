import { describe, expect, it } from "vitest"
import { inviteOutcome } from "./inviteOutcome"

const LINK = "http://localhost:3001/sign-in?mode=activate&email=new%40nerla.com&token=t"
const EXPIRES = "2026-10-31T12:00:00.000Z"

describe("inviteOutcome", () => {
  it("shows the link and says it is being emailed", () => {
    expect(inviteOutcome({ inviteUrl: LINK, inviteExpiresAt: EXPIRES, email: "sending" }, "new@nerla.com")).toEqual({
      kind: "link",
      email: "new@nerla.com",
      url: LINK,
      expiresAt: EXPIRES,
      emailing: true,
    })
  })

  it("shows the link alone when email is off", () => {
    expect(inviteOutcome({ inviteUrl: LINK, inviteExpiresAt: EXPIRES, email: "not-set-up" }, "new@nerla.com")).toMatchObject({
      kind: "link",
      emailing: false,
    })
    expect(inviteOutcome({ inviteUrl: LINK, inviteExpiresAt: EXPIRES }, "new@nerla.com")).toMatchObject({ kind: "link", emailing: false })
  })

  it("reads an invite back as a rejoin with no link", () => {
    expect(inviteOutcome({ rejoin: true, inviteExpiresAt: EXPIRES, email: "not-set-up" }, "bob@nerla.com")).toEqual({
      kind: "rejoin",
      email: "bob@nerla.com",
      expiresAt: EXPIRES,
      emailing: false,
    })
  })

  it("never offers an empty or unusable link", () => {
    expect(inviteOutcome({}, "new@nerla.com")).toEqual({ kind: "error", email: "new@nerla.com" })
    expect(inviteOutcome({ inviteUrl: LINK }, "new@nerla.com")).toEqual({ kind: "error", email: "new@nerla.com" })
    expect(inviteOutcome({ inviteUrl: "", inviteExpiresAt: EXPIRES }, "new@nerla.com")).toEqual({ kind: "error", email: "new@nerla.com" })
  })
})
