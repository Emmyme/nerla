import { describe, expect, it } from "vitest"
import { homeSummary, NOTHING_TODAY } from "./homeSummary"

const now = new Date(2026, 9, 22, 10, 52)
const at = (day: number, hours: number, minutes = 0) => ({ starts_at: new Date(2026, 9, day, hours, minutes).toISOString() })
const due = (due_date: string | null, status = "todo") => ({ due_date, status })

describe("homeSummary", () => {
  it("joins events today, overdue tasks and tasks due today", () => {
    const events = [at(22, 9, 30), at(22, 11), at(22, 14), at(22, 16), at(23, 9, 30), at(21, 10)]
    const tasks = [due("2026-10-20"), due("2026-10-22"), due("2026-10-22", "in_progress"), due("2026-10-24"), due(null)]
    expect(homeSummary({ events, tasks, now })).toBe("4 events today · 1 task overdue · 2 due today")
  })

  it("leaves out backlog tasks", () => {
    expect(homeSummary({ events: [], tasks: [due("2026-10-21", "backlog")], now })).toBe(NOTHING_TODAY)
  })

  it("does not count events the user declined", () => {
    const events = [at(22, 9), { ...at(22, 11), viewer_response: "no" }, { ...at(22, 13), viewer_response: "pending" }]
    expect(homeSummary({ events, tasks: [], now })).toBe("2 events today")
  })

  it("leaves out parts that are zero", () => {
    expect(homeSummary({ events: [at(22, 9), at(22, 13)], tasks: [due("2026-10-22"), due("2026-10-22")], now })).toBe(
      "2 events today · 2 due today",
    )
    expect(homeSummary({ events: [], tasks: [due("2026-10-01"), due("2026-10-21")], now })).toBe("2 tasks overdue")
  })

  it("uses singular forms", () => {
    expect(homeSummary({ events: [at(22, 9)], tasks: [due("2026-10-21"), due("2026-10-22")], now })).toBe(
      "1 event today · 1 task overdue · 1 due today",
    )
  })

  it("says nothing is scheduled when every part is zero", () => {
    expect(homeSummary({ events: [at(23, 9)], tasks: [due("2026-10-25")], now })).toBe("Nothing scheduled today")
  })

  it("never counts done tasks", () => {
    expect(homeSummary({ events: [], tasks: [due("2026-10-20", "done"), due("2026-10-22", "done")], now })).toBe("Nothing scheduled today")
  })

  it("skips empty and invalid dates without throwing", () => {
    const events = [{ starts_at: "" }, { starts_at: "not a date" }, at(22, 9)]
    const tasks = [due(""), due("soon"), due("2026-13-40")]
    expect(homeSummary({ events, tasks, now })).toBe("1 event today")
  })

  it("places all-day events on their calendar date", () => {
    expect(homeSummary({ events: [{ starts_at: "2026-10-22T00:00:00.000Z", all_day: true }], tasks: [], now })).toBe("1 event today")
  })

  it("counts an event over several days on each day it covers", () => {
    const trip = { starts_at: "2026-10-21T00:00:00.000Z", ends_at: "2026-10-24T00:00:00.000Z", all_day: true }
    const overnight = { ...at(21, 22), ends_at: new Date(2026, 9, 22, 1).toISOString() }
    expect(homeSummary({ events: [trip, overnight], tasks: [], now })).toBe("2 events today")
  })
})
