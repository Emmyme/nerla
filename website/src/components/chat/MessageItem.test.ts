import { describe, expect, it } from "vitest"
import { messageRights } from "./messageRights"

const ai = { kind: "ai" as const, speaker: "ai" as const }

describe("messageRights", () => {
  it("lets the user edit and delete only their own messages", () => {
    expect(messageRights({ sender_id: "me", done_via: null }, "me", false)).toEqual({ edit: true, delete: true, pin: false })
    expect(messageRights({ sender_id: "bob", done_via: null }, "me", false)).toEqual({ edit: false, delete: false, pin: false })
  })

  it("lets the user take back what the AI said for them, but never edit its words", () => {
    expect(messageRights({ sender_id: "me", done_via: ai }, "me", false)).toEqual({ edit: false, delete: true, pin: false })
  })

  it("pins only where the chat allows it, whoever sent the message", () => {
    expect(messageRights({ sender_id: "bob", done_via: null }, "me", true)).toEqual({ edit: false, delete: false, pin: true })
    expect(messageRights({ sender_id: "me", done_via: null }, "me", true).pin).toBe(true)
  })
})
