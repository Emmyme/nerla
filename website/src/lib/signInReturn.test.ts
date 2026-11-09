import { describe, expect, it } from "vitest"
import { returnPath, signInPath } from "./signInReturn"

describe("sign-in return path", () => {
  it("keeps a meeting link through sign-in", () => {
    expect(signInPath("/meeting-room/meeting-3f2a")).toBe("/sign-in?next=%2Fmeeting-room%2Fmeeting-3f2a")
    expect(returnPath("/meeting-room/meeting-3f2a")).toBe("/meeting-room/meeting-3f2a")
    expect(signInPath("/calendar")).toBe("/sign-in")
  })

  it("never returns anywhere off the app", () => {
    for (const next of [
      null,
      "",
      "//evil.example",
      "https://evil.example/meeting-room/x",
      "/meeting-room/x/../../evil",
      "/meeting-room/x?y=1",
      "/calendar",
    ])
      expect(returnPath(next)).toBe("/")
  })
})
