import { describe, expect, it } from "vitest"
import { DisconnectReason } from "livekit-client"
import { endScreen } from "./endScreen"

describe("endScreen", () => {
  it("closes a member's meeting window after they leave", () => {
    expect(endScreen(undefined, true, false, true).close).toBe(true)
    expect(endScreen(DisconnectReason.CLIENT_INITIATED, false, false, true).close).toBe(true)
  })

  it("offers a rejoin after leaving anywhere else", () => {
    const left = { title: "You left the meeting", rejoin: true, close: false }
    expect(endScreen(undefined, true, false)).toMatchObject(left)
    expect(endScreen(undefined, true, true)).toMatchObject(left)
    expect(endScreen(undefined, true, true, true)).toMatchObject(left)
    expect(endScreen(DisconnectReason.CLIENT_INITIATED, false, true)).toMatchObject(left)
  })

  it("names the reason the call ended", () => {
    expect(endScreen(DisconnectReason.DUPLICATE_IDENTITY, false, false)).toMatchObject({
      title: "You joined from another window",
      rejoin: false,
      close: false,
    })
    expect(endScreen(DisconnectReason.ROOM_DELETED, false, true).title).toBe("The meeting ended")
    expect(endScreen(DisconnectReason.PARTICIPANT_REMOVED, false, true)).toMatchObject({
      title: "You were removed from the meeting",
      rejoin: false,
    })
  })

  it("treats anything else as a lost connection, with a rejoin", () => {
    const lost = { title: "Connection lost", body: "Check your internet and rejoin.", rejoin: true, close: false }
    expect(endScreen(undefined, false, false)).toEqual(lost)
    expect(endScreen(DisconnectReason.JOIN_FAILURE, false, true)).toEqual(lost)
    expect(endScreen(DisconnectReason.SIGNAL_CLOSE, false, false, true)).toEqual(lost)
  })
})
