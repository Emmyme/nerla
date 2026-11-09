import { describe, expect, it } from "vitest"
import { presenceName, roomPresence } from "./presence"

describe("roomPresence", () => {
  it("lists other members by name, counts guests and leaves out the caller and strangers", () => {
    const names = new Map([
      ["me", "Ada Lovelace"],
      ["jane", "Jane Smith"],
    ])
    const participants = [
      { identity: "me", metadata: '{"role":"member"}' },
      { identity: "jane", metadata: '{"role":"member"}' },
      { identity: "jane" },
      { identity: "guest-123", metadata: '{"role":"guest"}' },
      { identity: "other", metadata: '{"role":"guest"}' },
      { identity: "unknown" },
    ]
    expect(roomPresence(participants, "me", names)).toEqual({ people: [{ userId: "jane", name: "Jane Smith" }], guests: 2 })
  })

  it("never falls back to an email for a nameless member", () => {
    expect(presenceName(null, null)).toBe("Someone")
    expect(presenceName("Jane", null)).toBe("Jane")
  })
})
