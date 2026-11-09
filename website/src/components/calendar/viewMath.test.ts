import { describe, expect, it } from "vitest"
import type { CalendarEvent } from "@/lib/api/calendar"
import { addDays, dayKey, formatTime } from "@/lib/dates"
import type { CalendarItem } from "./items"
import type { MonthCell, MonthItem } from "./layout"
import { groupByDay, mergeLoaded, segmentsOf } from "./viewMath"

function item(key: string, start: Date, end: Date, allDay = false): CalendarItem {
  const entry = {
    id: key,
    occurrence_id: key,
    title: key,
    location: null,
    event_type: "event",
    busy: undefined,
  } as unknown as CalendarEvent
  const iso = (d: Date) => (allDay ? `${dayKey(d)}T00:00:00.000Z` : d.toISOString())
  return { key, entry, starts_at: iso(start), ends_at: iso(end), all_day: allDay, person: null }
}

const monday = new Date(2026, 9, 19)

function week(cells: Partial<MonthItem<CalendarItem>>[][]): MonthCell<CalendarItem>[] {
  return cells.map((items, i) => {
    const day = addDays(monday, i)
    const full = items.map(
      (it) =>
        ({ lane: 0, bar: true, first: false, span: 1, continuesBefore: false, continuesAfter: false, ...it }) as MonthItem<CalendarItem>,
    )
    return { day, key: dayKey(day), inMonth: true, items: full, more: 0, all: full }
  })
}

describe("segmentsOf", () => {
  const bar = item("trip", monday, addDays(monday, 3), true)

  it("draws a bar over consecutive visible days as one piece", () => {
    const cells = week([
      [{ event: bar, continuesAfter: true }],
      [{ event: bar, continuesBefore: true, continuesAfter: true }],
      [{ event: bar, continuesBefore: true }],
      [],
      [],
      [],
      [],
    ])
    const segments = segmentsOf(cells)
    expect(segments[0]).toHaveLength(1)
    expect(segments[0][0]).toMatchObject({ start: 0, span: 3, continuesBefore: false, continuesAfter: false })
    expect(segments[1]).toEqual([])
  })

  it("breaks a bar where a cell hides its lane, squaring the broken ends", () => {
    const cells = week([[{ event: bar, continuesAfter: true }], [], [{ event: bar, continuesBefore: true }], [], [], [], []])
    const segments = segmentsOf(cells)
    expect(segments[0][0]).toMatchObject({ start: 0, span: 1, continuesAfter: true })
    expect(segments[2][0]).toMatchObject({ start: 2, span: 1, continuesBefore: true, continuesAfter: false })
  })
})

describe("groupByDay", () => {
  it("lists an overnight event on each day it covers and keeps an empty today", () => {
    const start = new Date(2026, 9, 23, 22)
    const end = new Date(2026, 9, 25, 2)
    const lunch = item("lunch", new Date(2026, 9, 21, 12), new Date(2026, 9, 21, 13))
    const holiday = item("holiday", new Date(2026, 9, 21), new Date(2026, 9, 22), true)
    const days = groupByDay([item("night", start, end), lunch, holiday], monday, addDays(monday, 7), new Date(2026, 9, 20))

    expect(days.map((d) => d.key)).toEqual(["2026-10-20", "2026-10-21", "2026-10-23", "2026-10-24", "2026-10-25"])
    expect(days[0].rows).toEqual([])
    expect(days[1].rows.map((r) => r.item.key)).toEqual(["holiday", "lunch"])
    expect(days[2].rows[0].time).toBe(`From ${formatTime(start)}`)
    expect(days[3].rows[0].time).toBe("All day")
    expect(days[4].rows[0].time).toBe(`Until ${formatTime(end)}`)
  })
})

describe("mergeLoaded", () => {
  it("replaces the reloaded weeks, keeps the others and widens the range", () => {
    const week2 = addDays(monday, 7).getTime()
    const old = item("old", new Date(2026, 9, 20, 9), new Date(2026, 9, 20, 10))
    const kept = item("kept", new Date(2026, 9, 28, 9), new Date(2026, 9, 28, 10))
    const shown = { from: monday.getTime(), to: addDays(monday, 14).getTime(), items: [old, kept] }
    const fresh = item("fresh", new Date(2026, 9, 21, 9), new Date(2026, 9, 21, 10))
    const merged = mergeLoaded(shown, addDays(monday, -7).getTime(), week2, [fresh])
    expect(merged.items.map((i) => i.key).sort()).toEqual(["fresh", "kept"])
    expect(merged).toMatchObject({ from: addDays(monday, -7).getTime(), to: addDays(monday, 14).getTime() })
  })
})
