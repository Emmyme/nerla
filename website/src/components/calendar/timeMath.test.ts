import { describe, expect, it } from "vitest"
import { addDays } from "@/lib/dates"
import { timeAxis } from "./layout"
import {
  dayRange,
  dragMove,
  dragRange,
  dragResize,
  moveEvent,
  nextFreeHalfHour,
  nudgeEvent,
  pointerToDay,
  pointerToSlot,
  resizeEvent,
  snap,
  tapRange,
  type Slot,
} from "./timeMath"

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo, d, h, mi).toISOString()
const timed = (start: string, end: string) => ({ starts_at: start, ends_at: end, all_day: false })

describe("snap", () => {
  it("rounds to the nearest step", () => {
    expect(snap(7)).toBe(0)
    expect(snap(8)).toBe(15)
    expect(snap(52)).toBe(45)
    expect(snap(52, 30)).toBe(60)
  })
})

describe("pointerToSlot", () => {
  const week = Array.from({ length: 7 }, (_, i) => addDays(new Date(2026, 9, 19), i))
  const grid = { axis: timeAxis(week), top: 100, minuteHeight: 0.8 }

  it("turns a pointer height into the 15-minute slot under it", () => {
    const slot = pointerToSlot(100 + 0.8 * grid.axis.toAxis(0, 9 * 60 + 40), 0, grid)
    expect(slot.minutes).toBe(9 * 60 + 30)
    expect(slot.at).toEqual(new Date(2026, 9, 19, 9, 30))
    expect(pointerToSlot(0, 0, grid).minutes).toBe(0)
    expect(pointerToSlot(100000, 0, grid).at).toEqual(new Date(2026, 9, 19, 23, 45))
  })

  it("reads the same row as the same wall-clock time on the 25-hour day", () => {
    const y = 100 + 0.8 * grid.axis.toAxis(5, 9 * 60)
    expect(pointerToSlot(y, 5, grid).at).toEqual(new Date(2026, 9, 24, 9, 0))
    expect(pointerToSlot(y, 6, grid).at).toEqual(new Date(2026, 9, 25, 9, 0))
  })
})

describe("moveEvent", () => {
  it("moves by minutes and keeps the length", () => {
    expect(moveEvent(timed(local(2026, 9, 23, 9), local(2026, 9, 23, 10)), 45, 0)).toEqual({
      starts_at: local(2026, 9, 23, 9, 45),
      ends_at: local(2026, 9, 23, 10, 45),
    })
  })

  it("keeps the wall-clock time when moving across the daylight saving change", () => {
    expect(moveEvent(timed(local(2026, 9, 24, 9), local(2026, 9, 24, 10)), 0, 1)).toEqual({
      starts_at: local(2026, 9, 25, 9),
      ends_at: local(2026, 9, 25, 10),
    })
    expect(moveEvent(timed(local(2026, 2, 28, 9), local(2026, 2, 28, 9, 30)), 15, 1)).toEqual({
      starts_at: local(2026, 2, 29, 9, 15),
      ends_at: local(2026, 2, 29, 9, 45),
    })
  })

  it("moves an hour of real time through the repeated October hour", () => {
    const moved = moveEvent(timed(local(2026, 9, 25, 1, 30), local(2026, 9, 25, 2, 0)), 120, 0)
    expect(moved.starts_at).toBe("2026-10-25T01:30:00.000Z")
  })

  it("moves all-day events by whole dates", () => {
    expect(moveEvent({ starts_at: "2026-10-24T00:00:00.000Z", ends_at: "2026-10-26T00:00:00.000Z", all_day: true }, 0, 2)).toEqual({
      starts_at: "2026-10-26T00:00:00.000Z",
      ends_at: "2026-10-28T00:00:00.000Z",
    })
  })
})

describe("resizeEvent", () => {
  it("changes the end and never goes below 15 minutes", () => {
    const event = timed(local(2026, 9, 23, 9), local(2026, 9, 23, 10))
    expect(resizeEvent(event, 30).ends_at).toBe(local(2026, 9, 23, 10, 30))
    expect(resizeEvent(event, -120)).toEqual({ starts_at: local(2026, 9, 23, 9), ends_at: local(2026, 9, 23, 9, 15) })
  })

  it("resizes through the 25-hour night in real time", () => {
    const event = timed(local(2026, 9, 25, 1, 0), local(2026, 9, 25, 2, 0))
    expect(resizeEvent(event, 120).ends_at).toBe("2026-10-25T02:00:00.000Z")
  })
})

const slot = (y: number, mo: number, d: number, h: number, mi: number, dayIndex = 0): Slot => {
  const at = new Date(y, mo, d, h, mi)
  return { dayIndex, minutes: (at.getTime() - new Date(y, mo, d).getTime()) / 60000, at }
}

describe("ghost from a click or a drag", () => {
  it("makes the half hour a click falls in, kept inside the day", () => {
    expect(tapRange(slot(2026, 9, 23, 9, 45))).toEqual({ start: new Date(2026, 9, 23, 9, 30), end: new Date(2026, 9, 23, 10) })
    expect(tapRange(slot(2026, 9, 23, 23, 45)).end).toEqual(new Date(2026, 9, 24))
  })

  it("covers both slots of a drag in either direction", () => {
    const pressed = slot(2026, 9, 23, 10, 0)
    expect(dragRange(pressed, slot(2026, 9, 23, 11, 15))).toEqual({ start: new Date(2026, 9, 23, 10), end: new Date(2026, 9, 23, 11, 30) })
    expect(dragRange(pressed, slot(2026, 9, 23, 8, 45))).toEqual({
      start: new Date(2026, 9, 23, 8, 45),
      end: new Date(2026, 9, 23, 10, 15),
    })
  })

  it("runs across days from the earlier slot to the later one, backwards too and over the DST night", () => {
    const monday = slot(2026, 9, 19, 15, 0)
    const wednesday = slot(2026, 9, 21, 10, 45, 2)
    expect(dragRange(monday, wednesday)).toEqual({ start: new Date(2026, 9, 19, 15), end: new Date(2026, 9, 21, 11) })
    expect(dragRange(wednesday, monday)).toEqual({ start: new Date(2026, 9, 19, 15), end: new Date(2026, 9, 21, 11) })
    const overDst = dragRange(slot(2026, 9, 24, 22, 0, 5), slot(2026, 9, 25, 8, 45, 6))
    expect(overDst).toEqual({ start: new Date(2026, 9, 24, 22), end: new Date(2026, 9, 25, 9) })
    expect(overDst.end.getTime() - overDst.start.getTime()).toBe(12 * 3_600_000)
  })

  it("orders day slots for an all-day drag", () => {
    expect(dayRange(slot(2026, 9, 25, 0, 0), slot(2026, 9, 22, 0, 0))).toEqual({ start: new Date(2026, 9, 22), end: new Date(2026, 9, 25) })
  })

  it("finds the day column under the pointer", () => {
    expect(pointerToDay(50, 0, 700, 7)).toBe(0)
    expect(pointerToDay(650, 0, 700, 7)).toBe(6)
    expect(pointerToDay(900, 0, 700, 7)).toBe(6)
  })
})

describe("drag move and resize", () => {
  it("moves across days by the slots between grab and drop, at the same wall-clock time over the DST night", () => {
    const event = timed(local(2026, 9, 24, 9, 30), local(2026, 9, 24, 10))
    expect(dragMove(event, slot(2026, 9, 24, 9, 30, 5), slot(2026, 9, 25, 10, 15, 6))).toEqual({
      starts_at: local(2026, 9, 25, 10, 15),
      ends_at: local(2026, 9, 25, 10, 45),
    })
  })

  it("moves an all-day event by the days between the cells", () => {
    const event = { starts_at: "2026-10-22T00:00:00.000Z", ends_at: "2026-10-23T00:00:00.000Z", all_day: true }
    expect(dragMove(event, slot(2026, 9, 22, 0, 0), slot(2026, 9, 29, 0, 0)).starts_at).toBe("2026-10-29T00:00:00.000Z")
  })

  it("resizes by the real minutes the pointer moved", () => {
    const event = timed(local(2026, 9, 23, 9), local(2026, 9, 23, 10))
    expect(dragResize(event, slot(2026, 9, 23, 9, 45), slot(2026, 9, 23, 10, 30)).ends_at).toBe(local(2026, 9, 23, 10, 45))
  })
})

describe("keyboard nudge", () => {
  const event = timed(local(2026, 9, 23, 9), local(2026, 9, 23, 10))

  it("moves by 15 minutes or a day and resizes with Shift", () => {
    expect(nudgeEvent(event, "ArrowDown")?.starts_at).toBe(local(2026, 9, 23, 9, 15))
    expect(nudgeEvent(event, "ArrowLeft")?.starts_at).toBe(local(2026, 9, 22, 9))
    expect(nudgeEvent(event, "ArrowUp", { month: true })?.starts_at).toBe(local(2026, 9, 16, 9))
    expect(nudgeEvent(event, "ArrowUp", { resize: true })?.ends_at).toBe(local(2026, 9, 23, 9, 45))
    expect(nudgeEvent(event, "ArrowRight", { resize: true })).toBeNull()
  })
})

describe("nextFreeHalfHour", () => {
  it("skips half hours that are taken", () => {
    const now = new Date(2026, 9, 23, 9, 10)
    const busy = [{ start: new Date(2026, 9, 23, 9, 30), end: new Date(2026, 9, 23, 10, 15) }]
    expect(nextFreeHalfHour(now, busy)).toEqual({ start: new Date(2026, 9, 23, 10, 30), end: new Date(2026, 9, 23, 11) })
  })
})
