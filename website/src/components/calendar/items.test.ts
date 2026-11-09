import { describe, expect, it } from "vitest"
import type { CalendarEntry } from "@/lib/api/calendar"
import { eventRights, joinOpen, recurrenceText } from "./items"

describe("recurrenceText", () => {
  const monday = new Date(2026, 9, 19, 15)

  it("reads a UTC UNTIL on the viewer's date, and a date UNTIL as that date", () => {
    expect(recurrenceText("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130T225959Z", monday)).toBe("Weekly on Monday, until 30 November 2026")
    expect(recurrenceText("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130T233000Z", monday)).toBe("Weekly on Monday, until 1 December 2026")
    expect(recurrenceText("FREQ=MONTHLY;BYDAY=2TU;UNTIL=20261130", monday)).toBe("Monthly on the second Tuesday, until 30 November 2026")
  })
})

describe("joinOpen", () => {
  const call = (starts_at: string, ends_at: string, all_day = false, video_call = true) => ({ starts_at, ends_at, all_day, video_call })
  const review = call(new Date(2026, 9, 23, 15).toISOString(), new Date(2026, 9, 23, 15, 45).toISOString())
  const at = (hours: number, minutes = 0) => new Date(2026, 9, 23, hours, minutes)

  it("opens ten minutes before the start and closes at the end, on video events only", () => {
    expect(joinOpen(review, at(14, 49))).toBe(false)
    expect(joinOpen(review, at(14, 50))).toBe(true)
    expect(joinOpen(review, at(15, 45))).toBe(false)
    expect(joinOpen({ ...review, video_call: false }, at(15))).toBe(false)
  })

  it("keeps an all-day call open through its days", () => {
    const offsite = call("2026-10-23T00:00:00.000Z", "2026-10-25T00:00:00.000Z", true)
    expect(joinOpen(offsite, new Date(2026, 9, 24, 23, 59))).toBe(true)
    expect(joinOpen(offsite, new Date(2026, 9, 25, 0, 0))).toBe(false)
  })
})

describe("eventRights", () => {
  const event = (id: string, created_by: string) => ({ id, created_by, busy: undefined }) as unknown as CalendarEntry
  const busy = { id: "b", busy: true } as unknown as CalendarEntry

  it("lets the creator edit, and an admin edit and delete, a saved event", () => {
    expect(eventRights(event("e", "me"), "me", false)).toEqual({ edit: true, delete: false })
    expect(eventRights(event("e", "ann"), "me", true)).toEqual({ edit: true, delete: true })
    expect(eventRights(event("e", "ann"), "me", false)).toEqual({ edit: false, delete: false })
    expect(eventRights(event("e", "ann"), undefined, false)).toEqual({ edit: false, delete: false })
  })

  // The store holds the delete of an event still saving until the save returns its id
  it("never edits an event still saving, though an admin may delete it, and offers nothing on busy time", () => {
    expect(eventRights(event("temp-1", "me"), "me", true)).toEqual({ edit: false, delete: true })
    expect(eventRights(busy, "me", true)).toEqual({ edit: false, delete: false })
  })
})
