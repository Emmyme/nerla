import { describe, expect, it } from "vitest"
import { pickOrg } from "./tenancy"

describe("pickOrg", () => {
  it("refuses a user with no membership", () => {
    expect(pickOrg([])).toEqual({ status: 403, error: "no-organization" })
  })

  it("acts in the only membership", () => {
    expect(pickOrg([{ organizationId: "org-a", role: "admin" }])).toEqual({ organizationId: "org-a", role: "admin" })
    expect(pickOrg([{ organizationId: "org-a", role: "member" }])).toEqual({ organizationId: "org-a", role: "member" })
  })

  it("refuses an account in two workspaces", () => {
    const memberships = [
      { organizationId: "org-a", role: "admin" },
      { organizationId: "org-b", role: "member" },
    ]
    expect(pickOrg(memberships)).toEqual({ status: 409, error: "multiple-organizations" })
  })

  it("counts duplicate rows of one workspace once, admin only when all agree", () => {
    const memberships = [
      { organizationId: "org-a", role: "admin" },
      { organizationId: "org-a", role: "member" },
    ]
    expect(pickOrg(memberships)).toEqual({ organizationId: "org-a", role: "member" })
  })
})
