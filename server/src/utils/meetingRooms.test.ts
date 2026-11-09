import { describe, expect, it } from "vitest"
import { foreignRoom, instantRoom, roomKind } from "./meetingRooms"
import { dmRoom } from "./chatAccess"

const A = "3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b"
const B = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b"
const ORG = "c0ffee12-0000-4000-8000-000000000001"
const OTHER_ORG = "deadbeef-0000-4000-8000-000000000002"

describe("roomKind", () => {
  it("recognises a scheduled room in mixed case and returns the id lowercase", () => {
    expect(roomKind(`meeting-${A.toUpperCase()}`)).toEqual({ kind: "scheduled", eventId: A })
  })

  it("parses old and workspace-prefixed dm rooms", () => {
    expect(roomKind(`dm-${A}-${B}`)).toEqual({ kind: "dm", org: null, a: A, b: B })
    expect(roomKind(`oc0ffee12-dm-${A}-${B}`)).toEqual({ kind: "dm", org: "c0ffee12", a: A, b: B })
  })

  it("parses old and workspace-prefixed instant rooms, and refuses anything else", () => {
    expect(roomKind(A)).toEqual({ kind: "instant", org: null })
    expect(roomKind(`oc0ffee12-${A}`)).toEqual({ kind: "instant", org: "c0ffee12" })
    for (const name of ["standup", `oc0ffee1-${A}`, `oc0ffee12-standup`]) expect(roomKind(name)).toEqual({ kind: "invalid" })
  })

  it("names new rooms after the workspace and tells another workspace's rooms apart", () => {
    const room = instantRoom(ORG)
    expect(roomKind(room)).toEqual({ kind: "instant", org: "c0ffee12" })
    expect(foreignRoom(room, ORG)).toBe(false)
    expect(foreignRoom(room, OTHER_ORG)).toBe(true)
    expect(foreignRoom(dmRoom(ORG, A, B), OTHER_ORG)).toBe(true)
    expect(foreignRoom(A, OTHER_ORG)).toBe(false)
    expect(foreignRoom(`dm-${A}-${B}`, OTHER_ORG)).toBe(false)
  })
})

describe("dmRoom", () => {
  it("is the same workspace room whoever calls", () => {
    expect(dmRoom(ORG, B, A.toUpperCase())).toBe(`oc0ffee12-dm-${A}-${B}`)
    expect(dmRoom(ORG, A, B)).toBe(dmRoom(ORG, B, A))
  })
})
