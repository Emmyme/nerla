import { describe, expect, it } from "vitest"
import type { calendarEvents } from "../db/schema"
import { toVisibleEventDto } from "./eventDto"

const row: typeof calendarEvents.$inferSelect = {
  id: "e1",
  title: "Dentist",
  description: "Root canal",
  location: "Main St",
  startsAt: "2026-10-23 14:00:00",
  endsAt: "2026-10-23 15:00:00",
  allDay: false,
  createdBy: "creator",
  organizationId: "org",
  eventType: "personal",
  videoCall: false,
  everyone: false,
  recurrenceRule: null,
  recurrenceTz: null,
  seriesId: null,
  originalStart: null,
  cancelled: false,
  reminderMinutes: null,
  doneVia: null,
  deletedAt: null,
  deletedBy: null,
  deletedVia: null,
  trashRoot: null,
  trashGuests: null,
  createdAt: "2026-10-01 08:00:00",
  updatedAt: "2026-10-01 08:00:00",
}

const extras = { calendarUserId: "teammate", attendees: [], viewerResponse: null }

describe("toVisibleEventDto", () => {
  it("keeps the creator and organizer on a full row", () => {
    const organizer = { id: "creator", firstName: "Ada", lastName: "Lind", avatarUrl: null }
    expect(toVisibleEventDto(row, "full", { ...extras, organizer })).toMatchObject({
      title: "Dentist",
      created_by: "creator",
      calendar_user_id: "teammate",
      organizer: { id: "creator", first_name: "Ada", last_name: "Lind", avatar_url: null },
    })
  })

  it("drops the creator and every detail from a busy row", () => {
    const busy = toVisibleEventDto(row, "busy", extras)
    expect(busy).toEqual({
      id: expect.stringMatching(/^busy-[0-9a-f]{20}$/),
      starts_at: "2026-10-23T14:00:00.000Z",
      ends_at: "2026-10-23T15:00:00.000Z",
      all_day: false,
      calendar_user_id: "teammate",
      busy: true,
    })
    expect(busy).not.toHaveProperty("created_by")
    expect(busy).not.toHaveProperty("organizer")
  })

  it("gives busy blocks of one event different opaque ids on different calendars", () => {
    const a = toVisibleEventDto(row, "busy", extras)!
    const b = toVisibleEventDto(row, "busy", { ...extras, calendarUserId: "other" })!
    expect(a.id).not.toBe("e1")
    expect(a.id).not.toBe(b.id)
    expect(toVisibleEventDto(row, "busy", extras)!.id).toBe(a.id)
  })

  it("sends nothing for a hidden row", () => {
    expect(toVisibleEventDto(row, "hidden", extras)).toBeNull()
  })
})
