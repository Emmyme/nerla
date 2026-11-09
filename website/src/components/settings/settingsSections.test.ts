import { describe, expect, it } from "vitest"
import { adminRedirect, sectionAt, settingsSections } from "./settingsSections"

const ids = (isAdmin: boolean, aiVisible: boolean) => settingsSections({ isAdmin, aiVisible }).map((section) => section.id)

describe("settingsSections", () => {
  it("gives a member only Profile, Notifications, Calendar sharing and Accessibility", () => {
    expect(ids(false, false)).toEqual(["profile", "notifications", "calendar", "accessibility"])
  })

  it("gives an admin every section in order, with Workspace AI before Workspace", () => {
    expect(ids(true, true)).toEqual([
      "profile",
      "notifications",
      "calendar",
      "accessibility",
      "ai",
      "workspace-ai",
      "workspace",
      "members",
      "setup-check",
    ])
  })

  it("shows Workspace AI to an admin and never to a member", () => {
    expect(ids(true, false)).toContain("workspace-ai")
    expect(ids(false, true)).not.toContain("workspace-ai")
  })

  it("shows AI only while the AI or MCP is on", () => {
    expect(ids(false, true)).toContain("ai")
    expect(ids(false, false)).not.toContain("ai")
    expect(ids(true, false)).not.toContain("ai")
  })

  it("matches Workspace AI before Workspace", () => {
    expect(sectionAt("/settings/workspace-ai")?.id).toBe("workspace-ai")
    expect(sectionAt("/settings/workspace")?.id).toBe("workspace")
  })

  it("sends a member who opens an admin section to Profile once loaded", () => {
    expect(adminRedirect("/settings/members", false, false)).toBe("/settings/profile")
    expect(adminRedirect("/settings/workspace", false, false)).toBe("/settings/profile")
    expect(adminRedirect("/settings/workspace-ai", false, false)).toBe("/settings/profile")
    expect(adminRedirect("/settings/setup-check", false, false)).toBe("/settings/profile")
    expect(adminRedirect("/settings/members", false, true)).toBeNull()
    expect(adminRedirect("/settings/members", true, false)).toBeNull()
    expect(adminRedirect("/settings/calendar", false, false)).toBeNull()
    expect(adminRedirect("/settings/notifications", false, false)).toBeNull()
    expect(adminRedirect("/settings/accessibility", false, false)).toBeNull()
  })
})
