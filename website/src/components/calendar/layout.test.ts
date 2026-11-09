import { describe, expect, it } from "vitest"
import { addDays, dayKey } from "@/lib/dates"
import { layoutDay, monthCells, packAllDay, timeAxis } from "./layout"

type Ev = { id: string; starts_at: string; ends_at: string; all_day: boolean }

const day = new Date(2026, 9, 23)

function timed(id: string, from: [number, number], to: [number, number], on: Date = day): Ev {
  const at = ([h, m]: [number, number]) => new Date(on.getFullYear(), on.getMonth(), on.getDate(), h, m).toISOString()
  return { id, starts_at: at(from), ends_at: at(to), all_day: false }
}

function allDay(id: string, first: string, daysLong: number): Ev {
  const start = new Date(`${first}T00:00:00.000Z`)
  return { id, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + daysLong * 86_400_000).toISOString(), all_day: true }
}

const shape = (blocks: ReturnType<typeof layoutDay<Ev>>) =>
  Object.fromEntries(blocks.map((b) => [b.event.id, { col: b.col, cols: b.cols, span: b.span }]))

const round = (n: number) => Math.round(n * 1000) / 1000
const geometry = (blocks: ReturnType<typeof layoutDay<Ev>>) =>
  Object.fromEntries(blocks.map((b) => [b.event.id, [b.depth, round(b.left), round(b.width)]]))

describe("layoutDay", () => {
  it("puts events that start close together in columns, each reaching 1.7 slots under the later ones", () => {
    const blocks = layoutDay([timed("a", [9, 0], [11, 0]), timed("b", [9, 10], [10, 30]), timed("c", [9, 20], [11, 0])], day)
    expect(shape(blocks)).toEqual({ a: { col: 0, cols: 3, span: 1 }, b: { col: 1, cols: 3, span: 1 }, c: { col: 2, cols: 3, span: 1 } })
    expect(geometry(blocks)).toEqual({ a: [0, 0, 0.567], b: [0, 0.333, 0.567], c: [0, 0.667, 0.333] })
    const pair = geometry(layoutDay([timed("a", [9, 0], [10, 0]), timed("b", [9, 0], [10, 0])], day))
    expect(pair).toEqual({ a: [0, 0, 0.85], b: [0, 0.5, 0.5] })
  })

  it("indents an event that starts half an hour or more after the events it overlaps", () => {
    const blocks = layoutDay([timed("a", [9, 0], [11, 0]), timed("b", [9, 30], [10, 30]), timed("c", [10, 0], [11, 0])], day)
    expect(geometry(blocks)).toEqual({ a: [0, 0, 1], b: [1, 0, 1], c: [2, 0, 1] })
    const joined = geometry(layoutDay([timed("a", [9, 0], [12, 0]), timed("b", [10, 0], [11, 0]), timed("c", [10, 15], [11, 0])], day))
    expect(joined).toEqual({ a: [0, 0, 1], b: [1, 0, 0.85], c: [1, 0.5, 0.5] })
  })

  it("gives an event after a cluster the full width", () => {
    const blocks = layoutDay([timed("a", [9, 0], [10, 0]), timed("b", [9, 0], [10, 0]), timed("c", [10, 0], [11, 0])], day)
    expect(shape(blocks).c).toEqual({ col: 0, cols: 1, span: 1 })
    expect(geometry(blocks).c).toEqual([0, 0, 1])
    expect(shape(blocks).a.cols).toBe(2)
  })

  it("lets a later event widen into columns that are free by then", () => {
    const blocks = layoutDay(
      [timed("long", [9, 0], [12, 0]), timed("a", [9, 0], [9, 20]), timed("b", [9, 0], [9, 20]), timed("late", [9, 25], [11, 0])],
      day,
    )
    expect(shape(blocks)).toEqual({
      long: { col: 0, cols: 3, span: 1 },
      a: { col: 1, cols: 3, span: 1 },
      b: { col: 2, cols: 3, span: 1 },
      late: { col: 1, cols: 3, span: 2 },
    })
    expect(geometry(blocks).late).toEqual([0, 0.333, 0.667])
  })

  it("gives a 10-minute event a 20-minute block and clips events to the day", () => {
    const [short] = layoutDay([timed("short", [9, 0], [9, 10])], day)
    expect(short).toMatchObject({ top: 540, height: 20 })
    const [overnight] = layoutDay([timed("late", [22, 0], [26, 0], addDays(day, -1))], day)
    expect(overnight).toMatchObject({ top: 0, height: 120 })
    const [last] = layoutDay([timed("last", [23, 55], [24, 0])], day)
    expect(last).toMatchObject({ top: 1420, height: 20 })
  })

  it("leaves all-day events and events of 24 hours or more to the all-day row", () => {
    const blocks = layoutDay([allDay("off", "2026-10-23", 1), timed("trip", [8, 0], [32, 0]), timed("call", [9, 0], [9, 30])], day)
    expect(blocks.map((b) => b.event.id)).toEqual(["call"])
  })

  it("places events by real time on the 25-hour October day", () => {
    const fallBack = new Date(2026, 9, 25)
    const [nine] = layoutDay([timed("nine", [9, 0], [10, 0], fallBack)], fallBack)
    expect(nine).toMatchObject({ top: 600, height: 60 })
  })
})

describe("timeAxis", () => {
  it("has 25 rows of hours on the October daylight saving day and 23 in March", () => {
    const fallBack = timeAxis([new Date(2026, 9, 25)])
    expect(fallBack.rows).toHaveLength(25)
    expect(fallBack.rows.slice(1, 5).map((row) => [row.hour, row.repeated])).toEqual([
      [1, false],
      [2, false],
      [2, true],
      [3, false],
    ])
    expect(timeAxis([new Date(2026, 2, 29)]).rows).toHaveLength(23)
  })

  it("lines up wall-clock hours across a week with a 25-hour day", () => {
    const week = Array.from({ length: 7 }, (_, i) => addDays(new Date(2026, 9, 19), i))
    const axis = timeAxis(week)
    expect(axis.rows).toHaveLength(25)
    expect(axis.minutes).toBe(1500)
    expect(axis.toAxis(5, 540)).toBe(axis.toAxis(6, 600))
    expect(axis.fromAxis(6, axis.toAxis(5, 540))).toBe(600)
    expect(axis.fromAxis(5, 3 * 60 + 30)).toBe(180)
  })

  it("skips the missing March hour on that day only", () => {
    const week = Array.from({ length: 7 }, (_, i) => addDays(new Date(2026, 2, 23), i))
    const axis = timeAxis(week)
    expect(axis.rows).toHaveLength(24)
    expect(axis.toAxis(6, 120)).toBe(180)
    expect(axis.fromAxis(6, 150)).toBe(120)
    expect(axis.toAxis(6, 1380)).toBe(1440)
  })
})

describe("packAllDay", () => {
  const week = Array.from({ length: 7 }, (_, i) => addDays(new Date(2026, 9, 19), i))

  it("packs bars across days into the fewest rows", () => {
    const { rows, overflow } = packAllDay(
      [allDay("conf", "2026-10-20", 3), allDay("off", "2026-10-21", 1), allDay("fri", "2026-10-23", 1), allDay("before", "2026-10-15", 6)],
      week,
    )
    expect(rows.map((row) => row.map((bar) => [bar.event.id, bar.start, bar.span]))).toEqual([
      [
        ["before", 0, 2],
        ["off", 2, 1],
        ["fri", 4, 1],
      ],
      [["conf", 1, 3]],
    ])
    expect(rows[0][0]).toMatchObject({ continuesBefore: true, continuesAfter: false })
    expect(overflow.size).toBe(0)
  })

  it("shows one row fewer when bars do not fit and counts every hidden bar per day", () => {
    const { rows, overflow } = packAllDay(
      [allDay("a", "2026-10-21", 2), allDay("b", "2026-10-21", 1), allDay("c", "2026-10-21", 1)],
      week,
      2,
    )
    expect(rows.map((row) => row.map((bar) => bar.event.id))).toEqual([["a"]])
    expect(Object.fromEntries(overflow)).toEqual({ "2026-10-21": 2 })
  })

  it("shows an all-day event on the same dates in any zone", () => {
    const { rows } = packAllDay([allDay("sun", "2026-10-25", 1)], week)
    expect(rows[0][0]).toMatchObject({ start: 6, span: 1 })
  })
})

describe("monthCells", () => {
  it("builds a Monday-first 6 by 7 grid", () => {
    const cells = monthCells(new Date(2026, 9, 1), [], 3)
    expect(cells).toHaveLength(42)
    expect(dayKey(cells[0].day)).toBe("2026-09-28")
    expect(cells[0].inMonth).toBe(false)
    expect(cells[3].inMonth).toBe(true)
  })

  it("keeps a bar on one lane across its days and folds the rest into more", () => {
    const events = [
      allDay("trip", "2026-10-20", 3),
      timed("a", [9, 0], [10, 0], new Date(2026, 9, 21)),
      timed("b", [11, 0], [12, 0], new Date(2026, 9, 21)),
      timed("c", [13, 0], [14, 0], new Date(2026, 9, 21)),
      timed("d", [8, 0], [9, 0], new Date(2026, 9, 22)),
    ]
    const cells = monthCells(new Date(2026, 9, 1), events, 3)
    const cell = (key: string) => cells.find((c) => c.key === key)!
    expect(cell("2026-10-20").items.map((i) => [i.event.id, i.lane, i.first, i.span])).toEqual([["trip", 0, true, 3]])
    expect(cell("2026-10-21").items.map((i) => [i.event.id, i.lane])).toEqual([
      ["trip", 0],
      ["a", 1],
    ])
    expect(cell("2026-10-21").more).toBe(2)
    expect(cell("2026-10-21").all).toHaveLength(4)
    expect(cell("2026-10-22").items.map((i) => [i.event.id, i.lane, i.first])).toEqual([
      ["trip", 0, false],
      ["d", 1, true],
    ])
  })

  it("folds a cell whose bar sits below a free lane, so +N always has its slot", () => {
    const events = [allDay("b", "2026-10-19", 3), allDay("a", "2026-10-20", 3), allDay("c", "2026-10-21", 2)]
    const cells = monthCells(new Date(2026, 9, 1), events, 2)
    const cell = (key: string) => cells.find((c) => c.key === key)!
    expect(cell("2026-10-22").all.map((i) => [i.event.id, i.lane])).toEqual([
      ["a", 1],
      ["c", 2],
    ])
    expect(cell("2026-10-22")).toMatchObject({ items: [], more: 2 })
    expect(cell("2026-10-19")).toMatchObject({ more: 0 })
    expect(cell("2026-10-19").items.map((i) => i.event.id)).toEqual(["b"])
  })
})
