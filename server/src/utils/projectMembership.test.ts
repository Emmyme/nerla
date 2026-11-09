import { describe, expect, it } from "vitest"
import { nextProjectAdmin, removesLastAdmin } from "./projectMembership"

const admin = { userId: "admin", role: "admin", createdAt: "2026-01-01 09:00:00" }
const early = { userId: "early", role: "member", createdAt: "2026-02-01 09:00:00" }
const late = { userId: "late", role: "member", createdAt: "2026-03-01 09:00:00" }
const lateAdmin = { ...late, role: "admin" }

describe("nextProjectAdmin", () => {
  it.each([
    ["promotes nobody while another admin remains", [admin, early, lateAdmin], null],
    ["promotes the earliest remaining member when the last admin leaves", [late, admin, early], "early"],
    ["promotes nobody when the leaver was the only member", [admin], null],
  ])("%s", (_name, members, promoted) => {
    expect(nextProjectAdmin(members, "admin")).toBe(promoted)
  })
})

describe("removesLastAdmin", () => {
  it.each([
    ["refuses the last admin demoting themselves", [admin, early], true],
    ["allows a demotion while another admin remains", [admin, lateAdmin], false],
  ])("%s", (_name, members, refused) => {
    expect(removesLastAdmin(members, "admin", "member")).toBe(refused)
  })
})
