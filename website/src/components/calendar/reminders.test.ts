import { describe, expect, it } from "vitest"
import type { BusyEvent, CalendarEvent, ReminderMinutes } from "@/lib/api/calendar"
import { planReminders, pruneFired, reminderTitle, startsText } from "./reminders"

const MINUTE = 60_000
const ME = "me"
const at = (hours: number, minutes = 0) => new Date(2026, 9, 23, hours, minutes).getTime()

function event(start: number, reminder: ReminderMinutes | null, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  const id = extra.id ?? `e${start}`
  return {
    id,
    occurrence_id: id,
    series_id: null,
    original_start: null,
    title: "Design review",
    description: null,
    location: null,
    starts_at: new Date(start).toISOString(),
    ends_at: new Date(start + 30 * MINUTE).toISOString(),
    all_day: false,
    event_type: "meeting",
    video_call: true,
    everyone: false,
    recurrence_rule: null,
    recurrence_tz: null,
    reminder_minutes: reminder,
    created_by: "me",
    organizer: { id: "me", first_name: null, last_name: null, avatar_url: null },
    calendar_user_id: "me",
    attendees: [],
    viewer_response: null,
    created_at: "",
    updated_at: "",
    ...extra,
  }
}

const keys = (list: { key: string }[]) => list.map((reminder) => reminder.key)

describe("planReminders", () => {
  const review = event(at(10), 10)

  it("waits for the reminder time, then fires", () => {
    const early = planReminders([review], at(9, 49), new Set(), ME)
    expect(early.due).toEqual([])
    expect(early.nextAt).toBe(at(9, 50))
    expect(keys(planReminders([review], at(9, 50), new Set(), ME).due)).toHaveLength(1)
  })

  it("fires each occurrence at most once", () => {
    const first = planReminders([review], at(9, 50), new Set(), ME)
    const fired = new Set(keys(first.due))
    const again = planReminders([review], at(9, 52), fired, ME)
    expect(again.due).toEqual([])
    expect(again.nextAt).toBeNull()
  })

  it("keeps occurrences of one series apart", () => {
    const monday = event(at(10), 10, { id: "s", occurrence_id: "s@1", series_id: "s" })
    const tuesday = event(at(10) + 1440 * MINUTE, 10, { id: "s", occurrence_id: "s@2", series_id: "s" })
    const plan = planReminders([monday, tuesday], at(9, 55), new Set(), ME)
    expect(keys(plan.due)).toHaveLength(1)
    expect(plan.nextAt).toBe(at(9, 50) + 1440 * MINUTE)
  })

  it("fires a passed reminder at once when the event has not started, and skips it once it has", () => {
    expect(keys(planReminders([event(at(10, 4), 10)], at(10), new Set(), ME).due)).toHaveLength(1)
    expect(planReminders([event(at(9, 59), 10)], at(10), new Set(), ME).due).toEqual([])
  })

  it("still fires an at-the-start reminder whose timer runs a moment late", () => {
    expect(keys(planReminders([event(at(10), 0)], at(10) + 200, new Set(), ME).due)).toHaveLength(1)
  })

  it("leaves out events without a reminder, busy times, placeholders and declined events", () => {
    const busy: BusyEvent = {
      id: "b",
      starts_at: new Date(at(10)).toISOString(),
      ends_at: new Date(at(11)).toISOString(),
      all_day: false,
      calendar_user_id: ME,
      busy: true,
    }
    const placeholder = event(at(10), 10, { id: "temp-1" })
    const declined = event(at(10), 10, { id: "no", viewer_response: "no" })
    const plan = planReminders([event(at(10), null), busy, placeholder, declined], at(9, 55), new Set(), ME)
    expect(plan.due).toEqual([])
    expect(plan.nextAt).toBeNull()
  })

  it("reminds about an Everyone event only its organizer and guests", () => {
    const allHands = event(at(10), 10, { id: "all", everyone: true, created_by: "ann" })
    const guest = { user_id: ME, first_name: null, last_name: null, avatar_url: null, response: "pending" as const }
    expect(planReminders([allHands], at(9, 55), new Set(), ME).due).toEqual([])
    expect(planReminders([{ ...allHands, attendees: [guest] }], at(9, 55), new Set(), ME).due).toHaveLength(1)
    expect(planReminders([allHands], at(9, 55), new Set(), "ann").due).toHaveLength(1)
  })
})

describe("all-day reminders", () => {
  const day = (first: string, after: string, minutes: ReminderMinutes) =>
    event(0, minutes, { id: `d${first}`, all_day: true, starts_at: `${first}T00:00:00.000Z`, ends_at: `${after}T00:00:00.000Z` })
  const local = (date: number, hours: number) => new Date(2026, 9, date, hours).getTime()

  it("comes at 09:00 on the first day, or the day before for a one-day setting", () => {
    expect(planReminders([day("2026-10-23", "2026-10-24", 10)], local(23, 8), new Set(), ME).nextAt).toBe(local(23, 9))
    expect(planReminders([day("2026-10-23", "2026-10-24", 1440)], local(22, 8), new Set(), ME).nextAt).toBe(local(22, 9))
  })

  it("keeps 09:00 local across the change from summer time", () => {
    // 25 October 2026 is the day Stockholm goes back to UTC+1
    const sunday = planReminders([day("2026-10-25", "2026-10-26", 10)], local(25, 0), new Set(), ME).nextAt
    expect(sunday).toBe(Date.UTC(2026, 9, 25, 8))
    const saturday = planReminders([day("2026-10-25", "2026-10-26", 1440)], local(24, 0), new Set(), ME).nextAt
    expect(saturday).toBe(Date.UTC(2026, 9, 24, 7))
  })

  it("fires a missed on-day reminder through the first day, and a day-before one until midnight", () => {
    const onDay = day("2026-10-23", "2026-10-26", 30)
    const before = day("2026-10-24", "2026-10-25", 1440)
    expect(planReminders([onDay], local(23, 15), new Set(), ME).due).toHaveLength(1)
    expect(planReminders([onDay], local(24, 10), new Set(), ME).due).toEqual([])
    expect(planReminders([before], local(23, 22), new Set(), ME).due).toHaveLength(1)
    expect(planReminders([before], local(24, 1), new Set(), ME).due).toEqual([])
  })

  it("says the event is today or tomorrow", () => {
    const now = new Date(local(23, 9))
    const [today] = planReminders([day("2026-10-23", "2026-10-24", 10)], local(23, 9), new Set(), ME).due
    const [tomorrow] = planReminders([day("2026-10-24", "2026-10-25", 1440)], local(23, 9), new Set(), ME).due
    expect(reminderTitle(today, now)).toBe("Design review is today")
    expect(reminderTitle(tomorrow, now)).toBe("Design review is tomorrow")
  })
})

describe("pruneFired", () => {
  it("keeps keys until a day after their start", () => {
    expect(pruneFired([`a@${at(10)}`, `b@${at(10) - 1500 * MINUTE}`, "broken"], at(11))).toEqual([`a@${at(10)}`])
  })
})

describe("startsText", () => {
  const start = new Date(at(10))

  it("names the time left, in words for an hour and a day", () => {
    expect(startsText("Design review", start, new Date(at(9, 50)), 10)).toBe("Design review starts in 10 minutes")
    expect(startsText("Design review", start, new Date(at(9, 59)), 10)).toBe("Design review starts in 1 minute")
    expect(startsText("Design review", start, new Date(at(9)), 60)).toBe("Design review starts in 1 hour")
    expect(startsText("Design review", start, new Date(at(10) - 1440 * MINUTE), 1440)).toBe("Design review starts tomorrow")
    expect(startsText("Design review", start, new Date(at(10)), 0)).toBe("Design review starts now")
  })

  it("counts the real time left when the reminder fires late", () => {
    expect(startsText("Design review", start, new Date(at(9, 56)), 10)).toBe("Design review starts in 4 minutes")
  })
})
