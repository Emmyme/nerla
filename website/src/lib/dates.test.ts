import { describe, expect, it } from "vitest"
import {
  addMonths,
  allDayRange,
  dayKey,
  dayLength,
  formatCallLength,
  formatElapsed,
  formatDayTitle,
  formatDue,
  formatMonthTitle,
  formatShortMonthTitle,
  formatRangeTitle,
  formatRelative,
  formatShortDate,
  formatStartsIn,
  formatTimeRange,
  minutesOfDay,
  parseDueDate,
  parseServerDate,
  startOfMonth,
  startOfWeek,
  toDueDateValue,
  toInstant,
  weekNumber,
} from "@/lib/dates"

const now = new Date(2026, 9, 22, 10, 52)

describe("formatDue", () => {
  it("labels days relative to now", () => {
    expect(formatDue(new Date(2026, 9, 22, 17, 0), now)).toEqual({ text: "Today", tone: "today" })
    expect(formatDue(new Date(2026, 9, 23, 9, 0), now)).toEqual({ text: "Tomorrow", tone: "soon" })
    expect(formatDue(new Date(2026, 9, 21, 9, 0), now)).toEqual({ text: "1 day late", tone: "overdue" })
    expect(formatDue(new Date(2026, 9, 20, 9, 0), now)).toEqual({ text: "2 days late", tone: "overdue" })
    expect(formatDue(new Date(2026, 9, 28, 9, 0), now)).toEqual({ text: "Wed", tone: "soon" })
    expect(formatDue(new Date(2026, 10, 5, 9, 0), now)).toEqual({ text: "5 Nov", tone: "later" })
    expect(formatDue(new Date(2027, 0, 5, 9, 0), now)).toEqual({ text: "5 Jan 2027", tone: "later" })
  })

  it("compares calendar days, including across DST", () => {
    expect(formatDue(new Date(2026, 9, 23, 0, 30), new Date(2026, 9, 22, 23, 30))?.text).toBe("Tomorrow")
    expect(formatDue(new Date(2026, 2, 30, 9, 0), new Date(2026, 2, 28, 12, 0))?.text).toBe("Mon")
  })

  it("returns null for a missing or invalid date", () => {
    expect(formatDue(null, now)).toBeNull()
    expect(formatDue(new Date("not a date"), now)).toBeNull()
    expect(formatDue("not a date", now)).toBeNull()
  })
})

describe("parseServerDate", () => {
  it.each([
    ["reads the Postgres space format as a UTC instant", "2026-10-23 15:00:00", new Date(Date.UTC(2026, 9, 23, 15, 0))],
    ["returns null for garbage", "garbage", null],
  ])("%s", (_name, stored, instant) => {
    expect(parseServerDate(stored)).toEqual(instant)
  })
})

describe("due dates", () => {
  it("reads a stored due date as that local calendar day", () => {
    expect(parseDueDate("2026-10-25 00:00:00")).toEqual(new Date(2026, 9, 25))
  })

  it("sends the local calendar day of a Date", () => {
    expect(toDueDateValue(new Date(2026, 9, 5, 0, 30))).toBe("2026-10-05")
  })
})

describe("formatting helpers", () => {
  it("formats short dates, day titles and time ranges", () => {
    expect(formatShortDate(new Date(2026, 9, 25), now)).toBe("25 Oct")
    expect(formatShortDate(new Date(2027, 9, 25), now)).toBe("25 Oct 2027")
    expect(formatShortDate(new Date(2026, 8, 5), now)).toBe("5 Sep")
    expect(formatShortDate(new Date(2025, 8, 5), now)).toBe("5 Sep 2025")
    expect(formatDayTitle(new Date(2026, 9, 22))).toBe("Thursday 22 October")
    expect(formatTimeRange(new Date(2026, 9, 22, 9, 30), new Date(2026, 9, 22, 9, 45), "en-GB")).toBe("09:30 to 09:45")
    expect(formatTimeRange(new Date(2026, 9, 22, 9, 30), new Date(2026, 9, 22, 9, 45), "en-US")).toBe("09:30 to 09:45")
  })

  it("formats month titles and the time until an event starts", () => {
    expect(formatMonthTitle(new Date(2026, 9, 22), now)).toBe("October")
    expect(formatMonthTitle(new Date(2027, 0, 4), now)).toBe("January 2027")
    expect(formatShortMonthTitle(new Date(2026, 9, 22), now)).toBe("Oct")
    expect(formatShortMonthTitle(new Date(2027, 0, 4), now)).toBe("Jan 2027")
    expect(formatShortMonthTitle(new Date(2026, 8, 4), now)).toBe("Sep")
    expect(formatStartsIn(new Date(2026, 9, 22, 11, 0), now)).toBe("In 8 min")
    expect(formatStartsIn(new Date(2026, 9, 22, 14, 0), now)).toBe("In 3 h 8 min")
    expect(formatStartsIn(new Date(2026, 9, 22, 12, 52), now)).toBe("In 2 h")
    expect(formatStartsIn(new Date(2026, 9, 22, 10, 30), now)).toBe("Now")
  })

  it("formats a call clock and how long a call lasted", () => {
    expect(formatElapsed(65_000)).toBe("1:05")
    expect(formatElapsed(3_723_000)).toBe("1:02:03")
    expect(formatCallLength(40_000)).toBe("Less than a minute")
    expect(formatCallLength(25 * 60_000)).toBe("25 min")
    expect(formatCallLength(65 * 60_000)).toBe("1 h 5 min")
  })
})

describe("formatRelative", () => {
  it("counts minutes, hours and calendar days back from now", () => {
    expect(formatRelative(new Date(2026, 9, 22, 10, 52, 30), now)).toBe("just now")
    expect(formatRelative(new Date(2026, 9, 22, 10, 40), now)).toBe("12 min ago")
    expect(formatRelative(new Date(2026, 9, 22, 8, 50), now)).toBe("2h ago")
    expect(formatRelative(new Date(2026, 9, 21, 9, 0), now)).toBe("yesterday")
    expect(formatRelative(new Date(2026, 9, 19, 12, 0), now)).toBe("3 days ago")
    expect(formatRelative(new Date(2026, 9, 2, 12, 0), now)).toBe("2 Oct")
    expect(formatRelative("not a date", now)).toBe("")
  })
})

describe("calendar helpers", () => {
  it("moves by months, keeping the day where the month has it", () => {
    expect(addMonths(new Date(2026, 0, 31), 1)).toEqual(new Date(2026, 1, 28))
    expect(addMonths(new Date(2026, 9, 23), -10)).toEqual(new Date(2025, 11, 23))
    expect(startOfMonth(new Date(2026, 9, 23, 15))).toEqual(new Date(2026, 9, 1))
  })

  it("starts weeks on Monday and numbers them by ISO 8601", () => {
    expect(startOfWeek(new Date(2026, 9, 23, 15))).toEqual(new Date(2026, 9, 19))
    expect(startOfWeek(new Date(2026, 9, 25, 23, 30))).toEqual(new Date(2026, 9, 19))
    expect(startOfWeek(new Date(2026, 9, 26, 0, 0))).toEqual(new Date(2026, 9, 26))
    expect(weekNumber(new Date(2026, 9, 23))).toBe(43)
    expect(weekNumber(new Date(2027, 0, 1))).toBe(53)
    expect(weekNumber(new Date(2027, 0, 4))).toBe(1)
  })

  it("titles a day, a week and a month", () => {
    expect(formatRangeTitle("day", new Date(2026, 9, 23))).toBe("Friday 23 October 2026")
    expect(formatRangeTitle("week", new Date(2026, 9, 23))).toBe("19 to 25 October 2026")
    expect(formatRangeTitle("week", new Date(2026, 9, 1))).toBe("28 September to 4 October 2026")
    expect(formatRangeTitle("week", new Date(2026, 11, 30))).toBe("28 December 2026 to 3 January 2027")
    expect(formatRangeTitle("month", new Date(2026, 9, 23))).toBe("October 2026")
  })

  it("counts minutes of a day in real time, so daylight saving days have 23 and 25 hours", () => {
    expect(dayLength(new Date(2026, 9, 23))).toBe(1440)
    expect(dayLength(new Date(2026, 9, 25))).toBe(1500)
    expect(dayLength(new Date(2026, 2, 29))).toBe(1380)
    const fallBack = new Date(2026, 9, 25)
    expect(toInstant(fallBack, 600)).toEqual(new Date(2026, 9, 25, 9, 0))
    expect(minutesOfDay(new Date(2026, 9, 25, 9, 0))).toBe(600)
    expect(toInstant(new Date(2026, 2, 29, 17), 540)).toEqual(new Date(2026, 2, 29, 10, 0))
    expect(toInstant(new Date(2026, 9, 23), 540).toISOString()).toBe("2026-10-23T07:00:00.000Z")
  })

  it("reads the days an event covers, all-day ends exclusive", () => {
    const day = (iso: string) => dayKey(new Date(iso))
    const allDay = allDayRange({ starts_at: "2026-10-23T00:00:00.000Z", ends_at: "2026-10-26T00:00:00.000Z", all_day: true })
    expect(allDay && [dayKey(allDay.first), dayKey(allDay.last)]).toEqual(["2026-10-23", "2026-10-25"])
    const oneDay = allDayRange({ starts_at: "2026-10-23T00:00:00.000Z", ends_at: "2026-10-24T00:00:00.000Z", all_day: true })
    expect(oneDay && [dayKey(oneDay.first), dayKey(oneDay.last)]).toEqual(["2026-10-23", "2026-10-23"])
    const overnight = allDayRange({ starts_at: "2026-10-23T20:00:00.000Z", ends_at: "2026-10-23T23:00:00.000Z", all_day: false })
    expect(overnight && [dayKey(overnight.first), dayKey(overnight.last)]).toEqual(["2026-10-23", "2026-10-24"])
    const toMidnight = allDayRange({ starts_at: "2026-10-23T08:00:00.000Z", ends_at: "2026-10-23T22:00:00.000Z", all_day: false })
    expect(toMidnight && [dayKey(toMidnight.first), dayKey(toMidnight.last)]).toEqual(["2026-10-23", "2026-10-23"])
    expect(day("2026-10-23T22:30:00.000Z")).toBe("2026-10-24")
    expect(allDayRange({ starts_at: null, ends_at: null, all_day: false })).toBeNull()
  })
})
