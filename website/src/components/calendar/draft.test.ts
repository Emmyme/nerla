import { describe, expect, it } from "vitest"
import type { CalendarEvent } from "@/lib/api/calendar"
import { draftBody, draftFromEvent, draftPatch, draftTimes, duplicateDraft, newDraft, ruleFollowsOnly } from "./draft"
import { followStart } from "./recurrence"

describe("draftTimes", () => {
  it("stores all-day drafts as UTC dates with the end after the last day", () => {
    expect(draftTimes({ start: new Date(2026, 9, 22), end: new Date(2026, 9, 24), allDay: true })).toEqual({
      starts_at: "2026-10-22T00:00:00.000Z",
      ends_at: "2026-10-25T00:00:00.000Z",
      all_day: true,
    })
  })

  it("stores timed drafts as UTC instants", () => {
    expect(draftTimes({ start: new Date(2026, 9, 25, 9), end: new Date(2026, 9, 25, 9, 30), allDay: false })).toEqual({
      starts_at: "2026-10-25T08:00:00.000Z",
      ends_at: "2026-10-25T08:30:00.000Z",
      all_day: false,
    })
  })
})

describe("empty titles", () => {
  it("saves an empty title as (No title) and does not resend it on edit", () => {
    const draft = newDraft(new Date(2026, 9, 23, 9), new Date(2026, 9, 23, 9, 30), false)
    const body = draftBody({ ...draft, title: "  " })
    expect(body.title).toBe("(No title)")
    const event = {
      ...body,
      id: "e",
      occurrence_id: "e",
      series_id: null,
      all_day: false,
      location: null,
      description: null,
      recurrence_rule: null,
      attendees: [],
    } as unknown as CalendarEvent
    const reopened = draftFromEvent(event)
    expect(reopened.title).toBe("")
    expect(draftPatch(reopened, event)).toEqual({})
  })
})

describe("editing", () => {
  it("sends only what changed, and the zone only with a new rule", () => {
    const start = new Date(2026, 9, 23, 9)
    const body = draftBody(newDraft(start, new Date(2026, 9, 23, 10), false, { title: "Standup", rule: "FREQ=WEEKLY;BYDAY=FR" }))
    const event = {
      ...body,
      id: "e",
      occurrence_id: "e",
      series_id: "e",
      all_day: false,
      location: null,
      description: null,
      attendees: [],
    } as unknown as CalendarEvent
    const draft = draftFromEvent(event)
    expect(draftPatch({ ...draft, location: "Room 2" }, event)).toEqual({ location: "Room 2" })
    expect(draftPatch({ ...draft, rule: "FREQ=DAILY" }, event)).toEqual({
      recurrence_rule: "FREQ=DAILY",
      recurrence_tz: "Europe/Stockholm",
    })
    expect(draftPatch({ ...draft, rule: null }, event)).toEqual({ recurrence_rule: null })
  })
})

describe("moving one occurrence", () => {
  it("tells a rule that only followed the start from one the user picked", () => {
    const friday = new Date(2026, 9, 23, 9)
    const monday = new Date(2026, 9, 26, 9)
    const body = draftBody(newDraft(friday, new Date(2026, 9, 23, 10), false, { title: "Standup", rule: "FREQ=WEEKLY;BYDAY=FR" }))
    const event = {
      ...body,
      id: "e",
      occurrence_id: "e",
      series_id: "e",
      all_day: false,
      location: null,
      description: null,
      attendees: [],
    } as unknown as CalendarEvent
    const draft = draftFromEvent(event)
    const moved = { ...draft, start: monday, end: new Date(2026, 9, 26, 10), rule: followStart(draft.rule, friday, monday) }
    expect(moved.rule).toBe("FREQ=WEEKLY;BYDAY=MO")
    expect(ruleFollowsOnly(moved)).toBe(true)
    expect(ruleFollowsOnly({ ...moved, ruleTouched: true })).toBe(false)
    expect(ruleFollowsOnly({ ...moved, rule: "FREQ=DAILY" })).toBe(false)
  })

  it("keeps an untitled event untitled when duplicated", () => {
    const event = {
      ...draftBody(newDraft(new Date(2026, 9, 23, 9), new Date(2026, 9, 23, 10), false)),
      id: "e",
      attendees: [],
    } as unknown as CalendarEvent
    expect(duplicateDraft(event, null, "me").title).toBe("")
    expect(duplicateDraft({ ...event, title: "Standup" }, null, "me").title).toBe("Standup (copy)")
  })
})
