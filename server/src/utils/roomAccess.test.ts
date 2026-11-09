import { describe, expect, it } from "vitest"
import { directRoomAccess, type RoomRow } from "./roomAccess"

const ME = "11111111-1111-4111-8111-111111111111"
const PARTNER = "22222222-2222-4222-8222-222222222222"
const THIRD = "33333333-3333-4333-8333-333333333333"
const OUTSIDER = "44444444-4444-4444-8444-444444444444"
const DM = `dm-${ME}-${PARTNER}`
const INSTANT = "55555555-5555-4555-8555-555555555555"

const org = new Set([ME, PARTNER, THIRD])
const facts = (rows: RoomRow[] = [], taken = false) => ({ rows, taken, inOrg: (id: string) => org.has(id) })

describe("directRoomAccess", () => {
  it("lets a partner in the workspace into a 1:1 room and seeds both users", () => {
    expect(directRoomAccess(ME, DM, facts())).toEqual({ allowed: true, seed: [ME, PARTNER] })
    expect(directRoomAccess(PARTNER, DM, facts()).allowed).toBe(true)
  })

  it("refuses a 1:1 room whose other user is outside the workspace", () => {
    expect(directRoomAccess(ME, `dm-${ME}-${OUTSIDER}`, facts()).allowed).toBe(false)
  })

  it("lets a third user in only when a workspace member in the call invited them", () => {
    const rows = [
      { userId: ME, invitedBy: null },
      { userId: PARTNER, invitedBy: null },
      { userId: THIRD, invitedBy: ME },
    ]
    expect(directRoomAccess(THIRD, DM, facts(rows))).toEqual({ allowed: true, seed: [] })
    expect(directRoomAccess(THIRD, DM, facts(rows.filter((row) => row.userId !== ME))).allowed).toBe(false)
    expect(directRoomAccess(THIRD, `dm-${ME}-${OUTSIDER}`, facts(rows)).allowed).toBe(false)
  })

  it("refuses a third user with no invite", () => {
    const rows = [
      { userId: ME, invitedBy: null },
      { userId: THIRD, invitedBy: null },
    ]
    expect(directRoomAccess(THIRD, DM, facts(rows)).allowed).toBe(false)
    expect(directRoomAccess(THIRD, DM, facts()).allowed).toBe(false)
  })

  it("gives an unclaimed prefixed room to its first caller, and then only to its participants", () => {
    const prefixed = `o55555555-${INSTANT}`
    expect(directRoomAccess(ME, prefixed, facts())).toEqual({ allowed: true, seed: [ME] })
    const claimed = facts([{ userId: ME, invitedBy: null }])
    expect(directRoomAccess(ME, prefixed, claimed)).toEqual({ allowed: true, seed: [] })
    expect(directRoomAccess(THIRD, prefixed, claimed)).toEqual({ allowed: false, seed: [] })
  })

  it("treats an unclaimed old style room as missing, and keeps one with rows working", () => {
    expect(directRoomAccess(ME, INSTANT, facts())).toEqual({ allowed: false, seed: [], missing: true })
    const claimed = facts([{ userId: ME, invitedBy: null }])
    expect(directRoomAccess(ME, INSTANT, claimed)).toEqual({ allowed: true, seed: [] })
    expect(directRoomAccess(THIRD, INSTANT, claimed)).toEqual({ allowed: false, seed: [] })
  })

  it("treats a room held by another workspace as missing", () => {
    expect(directRoomAccess(ME, INSTANT, facts([], true))).toEqual({ allowed: false, seed: [], missing: true })
    expect(directRoomAccess(ME, DM, facts([], true))).toEqual({ allowed: false, seed: [], missing: true })
  })

  it("refuses an instant room that is not a room id", () => {
    for (const name of ["standup", `${INSTANT}x`, `room-${INSTANT}`]) expect(directRoomAccess(ME, name, facts()).allowed).toBe(false)
  })
})
