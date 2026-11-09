import { describe, expect, it } from "vitest"
import { INVITE_TTL, inviteLine, queueInvite, type Invite } from "./incoming"

const invite = (roomName: string, at: number, callerName = "Ada Lovelace"): Invite => ({
  roomName,
  callerId: `id-${callerName}`,
  callerName,
  title: "Weekly sync",
  at,
})

describe("queueInvite", () => {
  it("puts a new invite on top of the ones already showing", () => {
    const a = invite("meeting-a", 0)
    const b = invite("meeting-b", 1000)
    expect(queueInvite([a], b, 1000)).toEqual([b, a])
  })

  it("replaces an older invite to the same room with the newer one", () => {
    const old = invite("meeting-a", 0, "Ada Lovelace")
    const other = invite("meeting-b", 500)
    const again = invite("meeting-a", 2000, "Bo Svensson")
    expect(queueInvite([other, old], again, 2000)).toEqual([again, other])
  })

  it("keeps at most three, dropping the oldest", () => {
    const queue = [invite("c", 3000), invite("b", 2000), invite("a", 1000)]
    const d = invite("d", 4000)
    expect(queueInvite(queue, d, 4000)).toEqual([d, queue[0], queue[1]])
  })

  it("drops invites once they are 45 seconds old", () => {
    const stale = invite("meeting-a", 0)
    const fresh = invite("meeting-b", 1000)
    const next = invite("meeting-c", INVITE_TTL)
    expect(INVITE_TTL).toBe(45_000)
    expect(queueInvite([fresh, stale], next, INVITE_TTL)).toEqual([next, fresh])
    expect(queueInvite([stale], invite("meeting-c", INVITE_TTL - 1), INVITE_TTL - 1)).toHaveLength(2)
  })
})

describe("inviteLine", () => {
  it("says is calling for a DM room and names the meeting otherwise", () => {
    expect(inviteLine({ roomName: "dm-a-b", callerName: "Ada Lovelace", title: "Ada Lovelace" })).toBe("Ada Lovelace is calling")
    expect(inviteLine({ roomName: "meeting-1", callerName: "Ada Lovelace", title: "Weekly sync" })).toBe(
      "Ada Lovelace invited you to Weekly sync",
    )
    expect(inviteLine({ roomName: "abc", callerName: "Ada Lovelace", title: "Meeting" })).toBe("Ada Lovelace invited you to a meeting")
  })
})
