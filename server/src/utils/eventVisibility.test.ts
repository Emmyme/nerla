import { describe, expect, it } from "vitest"
import {
  eventAccess,
  redact,
  teamFloor,
  teammatesSeeDetails,
  visibilityFor,
  type SharingTowardViewer,
  type VisibilityContext,
} from "./eventVisibility"

type Level = SharingTowardViewer["default_level"]
type Grant = SharingTowardViewer["grantToViewer"]

const viewer = { id: "viewer" }
const event = (eventType: string, everyone = false) => ({ createdBy: "owner", eventType, everyone })
const sharing = (default_level: Level, grantToViewer: Grant = null): SharingTowardViewer => ({ default_level, grantToViewer })

/** The event sits on its creator's own calendar, so both sharings are the same. */
const team = (default_level: Level, grantToViewer: Grant = null): VisibilityContext => ({
  isCreator: false,
  isAttendee: false,
  ownerSharing: sharing(default_level, grantToViewer),
  creatorSharing: sharing(default_level, grantToViewer),
  mode: "team",
})

/** Creator Y's event on teammate X's calendar. */
const onTeammate = (owner: SharingTowardViewer, creator: SharingTowardViewer): VisibilityContext => ({
  ...team("details"),
  ownerSharing: owner,
  creatorSharing: creator,
})

describe("visibilityFor", () => {
  it("always shows the creator their own events", () => {
    const ctx = { ...team("private"), isCreator: true }
    expect(visibilityFor(event("personal"), viewer, ctx)).toBe("full")
    expect(visibilityFor({ ...event("focus"), createdBy: "viewer" }, viewer, team("private"))).toBe("full")
  })

  it("always shows guests the events they are invited to", () => {
    expect(visibilityFor(event("personal"), viewer, { ...team("private"), isAttendee: true })).toBe("full")
    expect(visibilityFor(event("meeting"), viewer, { ...team("busy"), mode: "mine", isAttendee: true })).toBe("full")
  })

  it("always shows Everyone events", () => {
    expect(visibilityFor(event("event", true), viewer, team("private"))).toBe("full")
    expect(visibilityFor(event("event", true), viewer, { ...team("details"), mode: "mine" })).toBe("full")
  })

  it("keeps other users' events out of My calendar", () => {
    expect(visibilityFor(event("meeting"), viewer, { ...team("details", "everything"), mode: "mine" })).toBe("hidden")
  })

  it("shows details but turns personal and focus events into busy blocks", () => {
    expect(visibilityFor(event("meeting"), viewer, team("details"))).toBe("full")
    expect(visibilityFor(event("personal"), viewer, team("details"))).toBe("busy")
    expect(visibilityFor(event("focus"), viewer, team("details"))).toBe("busy")
    expect(visibilityFor(event("focus"), viewer, team("details", "busy"))).toBe("busy")
  })

  it("shows everything to a viewer with an everything grant", () => {
    expect(visibilityFor(event("personal"), viewer, team("details", "everything"))).toBe("full")
    expect(visibilityFor(event("focus"), viewer, team("busy", "everything"))).toBe("full")
  })

  it("shows only busy blocks under the busy level", () => {
    expect(visibilityFor(event("meeting"), viewer, team("busy"))).toBe("busy")
  })

  it("hides a private calendar unless the viewer has a grant", () => {
    expect(visibilityFor(event("meeting"), viewer, team("private"))).toBe("hidden")
    expect(visibilityFor(event("meeting"), viewer, team("private", "busy"))).toBe("busy")
    expect(visibilityFor(event("personal"), viewer, team("private", "everything"))).toBe("full")
  })

  it("takes the stricter of the calendar owner's and the creator's sharing", () => {
    expect(visibilityFor(event("meeting"), viewer, onTeammate(sharing("details"), sharing("private")))).toBe("hidden")
    expect(visibilityFor(event("meeting"), viewer, onTeammate(sharing("private"), sharing("details")))).toBe("hidden")
    expect(visibilityFor(event("meeting"), viewer, onTeammate(sharing("busy"), sharing("details")))).toBe("busy")
    expect(visibilityFor(event("personal"), viewer, onTeammate(sharing("details", "everything"), sharing("details")))).toBe("busy")
    expect(visibilityFor(event("personal"), viewer, onTeammate(sharing("details", "everything"), sharing("private", "everything")))).toBe(
      "full",
    )
  })
})

describe("redact", () => {
  it("keeps only the busy block fields", () => {
    const dto = {
      id: "e1",
      title: "Dentist",
      description: "Root canal",
      location: "Main St",
      starts_at: "2026-10-23T14:00:00.000Z",
      ends_at: "2026-10-23T15:00:00.000Z",
      all_day: false,
      event_type: "personal",
      created_by: "owner",
      calendar_user_id: "teammate",
      attendees: [{ user_id: "u2" }],
    }
    const busy = redact(dto)
    expect(busy).toEqual({
      id: expect.stringMatching(/^busy-/),
      starts_at: "2026-10-23T14:00:00.000Z",
      ends_at: "2026-10-23T15:00:00.000Z",
      all_day: false,
      calendar_user_id: "teammate",
      busy: true,
    })
    expect(busy).not.toHaveProperty("created_by")
  })

  it("keeps out of office as a labelled block with its dates, and never its title", () => {
    const dto = {
      id: "e2",
      title: "Skiing",
      starts_at: "2026-10-27T00:00:00.000Z",
      ends_at: "2026-11-01T00:00:00.000Z",
      all_day: true,
      event_type: "ooo",
      calendar_user_id: "owner",
    }
    const visibility = teamFloor("ooo", visibilityFor(event("ooo"), viewer, onTeammate(sharing("details"), sharing("private"))))
    expect(visibility).toBe("busy")
    expect(redact(dto)).toEqual({
      id: expect.stringMatching(/^busy-/),
      starts_at: dto.starts_at,
      ends_at: dto.ends_at,
      all_day: true,
      calendar_user_id: "owner",
      busy: true,
      ooo: true,
    })
    expect(teamFloor("ooo", visibilityFor(event("ooo"), viewer, team("details")))).toBe("full")
    expect(teamFloor("meeting", "hidden")).toBe("hidden")
  })
})

describe("eventAccess", () => {
  const event = { createdBy: "owner" }
  const admin = { id: "admin", role: "admin" }
  const member = { id: "member", role: "member" }

  it("lets the creator do anything, and an admin delete anything", () => {
    expect(eventAccess("edit", event, { id: "owner", role: "member" }, "full")).toBe("allowed")
    expect(eventAccess("delete", event, admin, "hidden")).toBe("allowed")
  })

  it("lets an admin edit only what they see in full, and hides the rest", () => {
    expect(eventAccess("edit", event, admin, "full")).toBe("allowed")
    expect(eventAccess("edit", event, admin, "busy")).toBe("not-found")
    expect(eventAccess("edit", event, admin, "hidden")).toBe("not-found")
  })

  it("refuses other members, without revealing events they cannot see", () => {
    expect(eventAccess("edit", event, member, "full")).toBe("forbidden")
    expect(eventAccess("delete", event, member, "busy")).toBe("forbidden")
    expect(eventAccess("delete", event, member, "hidden")).toBe("not-found")
  })
})

describe("teammatesSeeDetails", () => {
  it("is true at details and with an everything grant, and false when every teammate sees a block or nothing", () => {
    expect(teammatesSeeDetails({ default_level: "details", grants: [] }, "meeting")).toBe(true)
    expect(teammatesSeeDetails({ default_level: "details", grants: [] }, "personal")).toBe(false)
    expect(teammatesSeeDetails({ default_level: "private", grants: [{ level: "busy" }] }, "meeting")).toBe(false)
    expect(teammatesSeeDetails({ default_level: "busy", grants: [{ level: "everything" }] }, "meeting")).toBe(true)
  })
})
