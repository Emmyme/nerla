import { describe, expect, it } from "vitest"
import { activeTab, tabBarHidden } from "./tabs"

describe("activeTab", () => {
  it("maps each route to its tab", () => {
    expect(activeTab("/")).toBe("home")
    expect(activeTab("/messages")).toBe("chat")
    expect(activeTab("/calendar")).toBe("calendar")
    expect(activeTab("/calendar/")).toBe("calendar")
    expect(activeTab("/projects")).toBe("projects")
    expect(activeTab("/project/web")).toBe("projects")
    expect(activeTab("/settings")).toBe("more")
    expect(activeTab("/settings/members")).toBe("more")
  })

  it("marks no tab on an unknown path", () => {
    expect(activeTab("/meeting-room/abc")).toBeNull()
    expect(activeTab("/calendars")).toBeNull()
    expect(activeTab("/project")).toBeNull()
  })
})

describe("tabBarHidden", () => {
  it("hides the bar on a phone conversation only", () => {
    expect(tabBarHidden("/messages", "?dm=x")).toBe(true)
    expect(tabBarHidden("/messages", "?group=x")).toBe(true)
    expect(tabBarHidden("/messages", "?filter=unread&group=x")).toBe(true)
    expect(tabBarHidden("/messages", "")).toBe(false)
    expect(tabBarHidden("/messages", "?new=group")).toBe(false)
    expect(tabBarHidden("/", "?dm=x")).toBe(false)
  })
})
