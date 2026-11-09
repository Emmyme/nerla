import { describe, expect, it } from "vitest"
import { eventsByDay, hasEnded, isRunning, nowLineIndex, type TimelineItem } from "./agendaTimeline"

const at = (hours: number, minutes = 0, day = 23) => new Date(2026, 9, day, hours, minutes)

function item(from: Date, to: Date, allDay = false): TimelineItem {
  return { start: from, end: to, event: { all_day: allDay } }
}

describe("agenda timeline", () => {
  const now = at(10, 25)
  const day = [
    item(at(0), at(24), true),
    item(at(9, 30), at(9, 45)),
    item(at(10), at(10, 30)),
    item(at(12, 30), at(14)),
    item(at(15), at(15, 45)),
  ]

  it("keeps a running event above the Now line and puts the line before the next start", () => {
    expect(isRunning(day[2], now)).toBe(true)
    expect(hasEnded(day[1], now)).toBe(true)
    expect(isRunning(day[0], now)).toBe(false)
    expect(nowLineIndex(day, now)).toBe(3)
  })

  it("puts the line last when nothing starts later today", () => {
    expect(nowLineIndex(day, at(16))).toBe(day.length)
  })
})

describe("eventsByDay", () => {
  const timed = (from: Date, to: Date) => ({ starts_at: from.toISOString(), ends_at: to.toISOString(), all_day: false })
  const allDay = (first: string, after: string) => ({
    starts_at: `${first}T00:00:00.000Z`,
    ends_at: `${after}T00:00:00.000Z`,
    all_day: true,
  })
  const daysOf = (map: Map<number, unknown[]>) => [...map.keys()].sort((a, b) => a - b).map((key) => new Date(key).getDate())

  it("puts an all-day event over several days on each of its dates, first in the day", () => {
    const trip = allDay("2026-10-23", "2026-10-26")
    const standup = timed(at(9, 30, 24), at(9, 45, 24))
    const byDay = eventsByDay([standup, trip])
    expect(daysOf(byDay)).toEqual([23, 24, 25])
    expect(byDay.get(at(0, 0, 24).getTime())!.map((entry) => entry.event)).toEqual([trip, standup])
    expect(byDay.get(at(0, 0, 25).getTime())![0]).toMatchObject({ index: 2, days: 3 })
  })

  it("shows a timed event past midnight on both days, and one ending at midnight on its day only", () => {
    expect(daysOf(eventsByDay([timed(at(22), at(1, 0, 24))]))).toEqual([23, 24])
    expect(daysOf(eventsByDay([timed(at(22), at(0, 0, 24))]))).toEqual([23])
  })

  it("lists only the shown days of a long event, counted from its first day", () => {
    const quarter = allDay("2026-09-01", "2026-12-01")
    const byDay = eventsByDay([quarter], { first: at(0, 0, 19), last: at(0, 0, 26) })
    expect(daysOf(byDay)).toEqual([19, 20, 21, 22, 23, 24, 25, 26])
    expect(byDay.get(at(0, 0, 23).getTime())![0]).toMatchObject({ index: 52, days: 91 })
  })

  it("keeps the real start and end on every day", () => {
    const late = timed(at(22), at(1, 0, 24))
    const second = eventsByDay([late]).get(at(0, 0, 24).getTime())![0]
    expect(second.start).toEqual(at(22))
    expect(second.end).toEqual(at(1, 0, 24))
  })
})
