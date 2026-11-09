import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  describeRecurrence,
  expandSeries,
  isValidRecurrenceRule,
  nextOccurrence,
  normalizeRecurrenceRule,
  occurrenceFieldsOf,
  occursAt,
  seriesTimeZone,
  shiftUntil,
  splitSeries,
} from "./recurrence"

type Row = {
  id: string
  title: string
  startsAt: string
  endsAt: string
  allDay: boolean
  recurrenceRule: string | null
  recurrenceTz: string | null
  seriesId: string | null
  originalStart: string | null
  cancelled: boolean
}

const master = (over: Partial<Row> = {}): Row => ({
  id: "series-1",
  title: "Engineering weekly",
  startsAt: "2026-10-19 07:00:00",
  endsAt: "2026-10-19 08:00:00",
  allDay: false,
  recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
  recurrenceTz: "Europe/Stockholm",
  seriesId: null,
  originalStart: null,
  cancelled: false,
  ...over,
})

const override = (originalStart: string, over: Partial<Row> = {}): Row =>
  master({ id: "override", recurrenceRule: null, seriesId: "series-1", originalStart, ...over })

const window = (from: string, to: string) => ({ from, to })
const starts = (list: { startsAt: string }[]) => list.map((o) => o.startsAt)

const ZONES = ["UTC", "Europe/Stockholm", "America/Los_Angeles"]

describe.each(ZONES)("with the process in %s", (zone) => {
  const previous = process.env.TZ
  beforeAll(() => {
    process.env.TZ = zone
  })
  afterAll(() => {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  })

  describe("expandSeries", () => {
    it("keeps a weekly 09:00 Stockholm series at 09:00 after the October change", () => {
      const list = expandSeries(master(), [], window("2026-10-19T00:00:00Z", "2026-11-03T00:00:00Z"))
      expect(starts(list)).toEqual(["2026-10-19T07:00:00.000Z", "2026-10-26T08:00:00.000Z", "2026-11-02T08:00:00.000Z"])
      expect(list[1]).toMatchObject({
        id: "series-1",
        endsAt: "2026-10-26T09:00:00.000Z",
        occurrence_id: "series-1:2026-10-26T08:00:00.000Z",
        series_id: "series-1",
        original_start: "2026-10-26T08:00:00.000Z",
      })
    })

    it("keeps it at 09:00 after the March change", () => {
      const spring = master({ startsAt: "2027-03-22 08:00:00", endsAt: "2027-03-22 09:00:00" })
      const list = expandSeries(spring, [], window("2027-03-22T00:00:00Z", "2027-03-30T00:00:00Z"))
      expect(starts(list)).toEqual(["2027-03-22T08:00:00.000Z", "2027-03-29T07:00:00.000Z"])
    })

    it("stops after COUNT occurrences", () => {
      const list = expandSeries(
        master({ recurrenceRule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3" }),
        [],
        window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"),
      )
      expect(list).toHaveLength(3)
    })

    it("drops a cancelled occurrence and swaps in a moved one", () => {
      const list = expandSeries(
        master(),
        [
          override("2026-10-26 08:00:00", { id: "cancelled", cancelled: true }),
          override("2026-11-02 08:00:00", {
            id: "moved",
            title: "Moved",
            startsAt: "2026-11-03 12:00:00",
            endsAt: "2026-11-03 13:00:00",
          }),
        ],
        window("2026-10-19T00:00:00Z", "2026-11-10T00:00:00Z"),
      )
      expect(starts(list)).toEqual(["2026-10-19T07:00:00.000Z", "2026-11-03T12:00:00.000Z", "2026-11-09T08:00:00.000Z"])
      expect(list[1]).toMatchObject({
        id: "moved",
        title: "Moved",
        occurrence_id: "series-1:2026-11-02T08:00:00.000Z",
        series_id: "series-1",
        original_start: "2026-11-02T08:00:00.000Z",
      })
    })

    it("ignores overrides of another series, as search passes every override it found", () => {
      const stray = override("2026-10-26 08:00:00", {
        id: "stray",
        seriesId: "series-2",
        startsAt: "2026-10-27 12:00:00",
        endsAt: "2026-10-27 13:00:00",
      })
      const list = expandSeries(master(), [stray], window("2026-10-19T00:00:00Z", "2026-11-03T00:00:00Z"))
      expect(list.map((o) => o.id)).toEqual(["series-1", "series-1", "series-1"])
    })

    it("clips to the window with an exclusive end", () => {
      const list = expandSeries(master(), [], window("2026-10-20T00:00:00Z", "2026-11-02T08:00:00Z"))
      expect(starts(list)).toEqual(["2026-10-26T08:00:00.000Z"])
    })

    it("includes an occurrence that started before the window and runs into it", () => {
      const list = expandSeries(master(), [], window("2026-10-26T08:30:00Z", "2026-10-27T00:00:00Z"))
      expect(starts(list)).toEqual(["2026-10-26T08:00:00.000Z"])
    })

    it("follows moved occurrences into and out of the window", () => {
      const list = expandSeries(
        master(),
        [
          override("2026-10-26 08:00:00", { id: "in", startsAt: "2026-11-02 12:00:00", endsAt: "2026-11-02 13:00:00" }),
          override("2026-11-02 08:00:00", { id: "out", startsAt: "2026-11-20 12:00:00", endsAt: "2026-11-20 13:00:00" }),
          override("2026-11-03 08:00:00", { id: "stale", startsAt: "2026-11-02 15:00:00", endsAt: "2026-11-02 16:00:00" }),
        ],
        window("2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z"),
      )
      expect(list.map((o) => o.id)).toEqual(["in"])
    })

    it("keeps the phase of a biweekly series that started years ago", () => {
      const old = master({
        startsAt: "2020-01-06 08:00:00",
        endsAt: "2020-01-06 09:00:00",
        recurrenceRule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
      })
      const list = expandSeries(old, [], window("2026-10-12T00:00:00Z", "2026-11-10T00:00:00Z"))
      expect(starts(list)).toEqual(["2026-10-19T07:00:00.000Z", "2026-11-02T08:00:00.000Z"])
    })

    it("keeps the day of old monthly and yearly series", () => {
      const monthly = master({
        startsAt: "2000-01-31 08:00:00",
        endsAt: "2000-01-31 09:00:00",
        recurrenceRule: "FREQ=MONTHLY",
      })
      expect(starts(expandSeries(monthly, [], window("2026-10-01T00:00:00Z", "2027-02-01T00:00:00Z")))).toEqual([
        "2026-10-31T08:00:00.000Z",
        "2026-12-31T08:00:00.000Z",
        "2027-01-31T08:00:00.000Z",
      ])
      const yearly = master({
        startsAt: "2000-02-29 08:00:00",
        endsAt: "2000-02-29 09:00:00",
        recurrenceRule: "FREQ=YEARLY",
      })
      expect(starts(expandSeries(yearly, [], window("2027-01-01T00:00:00Z", "2030-01-01T00:00:00Z")))).toEqual(["2028-02-29T08:00:00.000Z"])
    })

    it("moves an occurrence that falls in the spring gap", () => {
      const sunday = master({
        startsAt: "2027-03-21 01:30:00",
        endsAt: "2027-03-21 02:30:00",
        recurrenceRule: "FREQ=WEEKLY;BYDAY=SU",
      })
      const range = window("2027-03-27T00:00:00Z", "2027-03-29T00:00:00Z")
      expect(starts(expandSeries(sunday, [], range))).toEqual(["2027-03-28T01:30:00.000Z"])
      const moved = override("2027-03-28 01:30:00", { id: "moved", startsAt: "2027-03-28 08:00:00", endsAt: "2027-03-28 09:00:00" })
      const list = expandSeries(sunday, [moved], range)
      expect(list.map((o) => [o.id, o.startsAt])).toEqual([["moved", "2027-03-28T08:00:00.000Z"]])
    })

    it("caps a window at 500 occurrences", () => {
      const daily = master({ recurrenceRule: "FREQ=DAILY" })
      expect(expandSeries(daily, [], window("2026-10-19T00:00:00Z", "2030-01-01T00:00:00Z"))).toHaveLength(500)
      const moved = override("2026-10-20 07:00:00", { id: "moved", startsAt: "2026-10-20 12:00:00", endsAt: "2026-10-20 13:00:00" })
      expect(expandSeries(daily, [moved], window("2026-10-19T00:00:00Z", "2030-01-01T00:00:00Z"))).toHaveLength(500)
    })

    it("shows nothing for a window that starts when the event ends or holds bad times", () => {
      const lateNight = master({ recurrenceRule: null, recurrenceTz: null, startsAt: "2026-10-19 22:00:00", endsAt: "2026-10-20 00:00:00" })
      expect(expandSeries(lateNight, [], window("2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z"))).toEqual([])
      expect(expandSeries(master(), [], window("2026-10-26T09:00:00Z", "2026-11-02T08:00:00Z"))).toEqual([])
      const range = window("2026-10-19T00:00:00Z", "2026-11-03T00:00:00Z")
      expect(expandSeries(master(), [], { ...range, from: "soon" })).toEqual([])
      expect(expandSeries(master(), [], { ...range, to: "soon" })).toEqual([])
      expect(expandSeries(master({ startsAt: "soon" }), [], range)).toEqual([])
      expect(expandSeries(master({ endsAt: "soon" }), [], range)).toEqual([])
    })

    it("repeats all-day events on the same dates whatever the zone", () => {
      const allDay = master({
        allDay: true,
        startsAt: "2026-10-19 00:00:00",
        endsAt: "2026-10-20 00:00:00",
        recurrenceTz: "America/Los_Angeles",
      })
      const list = expandSeries(allDay, [], window("2026-10-25T00:00:00Z", "2026-11-03T00:00:00Z"))
      expect(starts(list)).toEqual(["2026-10-26T00:00:00.000Z", "2026-11-02T00:00:00.000Z"])
    })

    it("returns a single event once when it overlaps", () => {
      const single = master({ recurrenceRule: null, recurrenceTz: null })
      const list = expandSeries(single, [], window("2026-10-19T07:30:00Z", "2026-10-20T00:00:00Z"))
      expect(list).toEqual([expect.objectContaining({ occurrence_id: "series-1", series_id: null, original_start: null })])
      expect(expandSeries(single, [], window("2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z"))).toEqual([])
    })

    it("keeps an event with no length only when it starts inside the window", () => {
      const instant = master({ recurrenceRule: null, recurrenceTz: null, endsAt: "2026-10-19 07:00:00" })
      expect(expandSeries(instant, [], window("2026-10-19T07:00:00Z", "2026-10-19T08:00:00Z"))).toHaveLength(1)
      expect(expandSeries(instant, [], window("2026-10-19T06:00:00Z", "2026-10-19T07:00:00Z"))).toEqual([])
      expect(expandSeries(instant, [], window("2026-10-19T08:00:00Z", "2026-10-19T09:00:00Z"))).toEqual([])
    })

    it("keeps every day of an old weekly, monthly and yearly series when it restarts near the window", () => {
      const weekly = master({ startsAt: "2020-01-06 08:00:00", endsAt: "2020-01-06 09:00:00", recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,WE" })
      expect(starts(expandSeries(weekly, [], window("2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z")))).toEqual(["2026-10-21T07:00:00.000Z"])
      const lastFriday = master({
        startsAt: "2020-05-29 07:00:00",
        endsAt: "2020-05-29 08:00:00",
        recurrenceRule: "FREQ=MONTHLY;BYDAY=-1FR",
      })
      expect(starts(expandSeries(lastFriday, [], window("2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z")))).toEqual([
        "2026-10-30T08:00:00.000Z",
        "2026-11-27T08:00:00.000Z",
      ])
      const yearly = master({ startsAt: "2000-03-15 07:00:00", endsAt: "2000-03-15 08:00:00", recurrenceRule: "FREQ=YEARLY" })
      expect(starts(expandSeries(yearly, [], window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z")))).toEqual(["2026-03-15T07:00:00.000Z"])
    })
  })

  describe("occursAt and nextOccurrence", () => {
    const timing = { startsAt: "2026-10-19 07:00:00", allDay: false, recurrenceTz: "Europe/Stockholm" }

    it("find the series' own times only, at the same local time after the October change", () => {
      expect(occursAt("FREQ=WEEKLY;BYDAY=MO", "2026-10-26T08:00:00.000Z", timing)).toBe(true)
      expect(occursAt("FREQ=WEEKLY;BYDAY=MO", "2026-10-26T07:00:00.000Z", timing)).toBe(false)
      expect(occursAt("FREQ=HOURLY", "2026-10-19T07:00:00.000Z", timing)).toBe(false)
      expect(nextOccurrence("FREQ=WEEKLY;BYDAY=MO", "2026-10-19T07:00:00.000Z", timing)).toBe("2026-10-26T08:00:00.000Z")
      expect(nextOccurrence("FREQ=WEEKLY;BYDAY=MO;COUNT=2", "2026-10-26T08:00:00.000Z", timing)).toBeNull()
      expect(occursAt("FREQ=WEEKLY;BYDAY=MO", "soon", timing)).toBe(false)
      expect(nextOccurrence("FREQ=WEEKLY;BYDAY=MO", "soon", timing)).toBeNull()
    })
  })

  describe("splitSeries", () => {
    const timing = { startsAt: "2026-10-19 07:00:00", allDay: false, recurrenceTz: "Europe/Stockholm" }

    it("ends the old rule at its last occurrence before the split and carries the remaining count", () => {
      const { head, tail } = splitSeries("FREQ=WEEKLY;BYDAY=MO;COUNT=5", "2026-11-02T08:00:00.000Z", timing)
      expect(head).toBe("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261026T080000Z")
      expect(tail).toBe("FREQ=WEEKLY;BYDAY=MO;COUNT=3")
      const before = expandSeries(master({ recurrenceRule: head }), [], window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"))
      expect(starts(before)).toEqual(["2026-10-19T07:00:00.000Z", "2026-10-26T08:00:00.000Z"])
    })

    it("leaves nothing before a split at the first occurrence", () => {
      const { head, tail } = splitSeries("FREQ=WEEKLY;BYDAY=MO", "2026-10-19T07:00:00.000Z", timing)
      expect(head).toBeNull()
      expect(tail).toBe("FREQ=WEEKLY;BYDAY=MO")
    })

    it("refuses to split at a time the series does not produce", () => {
      expect(() => splitSeries("FREQ=WEEKLY;BYDAY=MO", "2026-10-20T07:00:00.000Z", timing)).toThrow()
      expect(() => splitSeries("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261027T000000Z", "2026-11-02T08:00:00.000Z", timing)).toThrow(
        "The series has no occurrence at that time",
      )
      expect(() => splitSeries("FREQ=WEEKLY;BYDAY=MO", "soon", timing)).toThrow("Cannot split an invalid series")
    })

    it("splits at an occurrence in the spring gap without keeping it in the old series", () => {
      const sunday = { startsAt: "2027-03-14 01:30:00", allDay: false, recurrenceTz: "Europe/Stockholm" }
      const { head } = splitSeries("FREQ=WEEKLY;BYDAY=SU", "2027-03-28T01:30:00.000Z", sunday)
      expect(head).toBe("FREQ=WEEKLY;BYDAY=SU;UNTIL=20270321T013000Z")
      const before = expandSeries(
        master({ startsAt: sunday.startsAt, endsAt: "2027-03-14 02:30:00", recurrenceRule: head }),
        [],
        window("2027-03-01T00:00:00Z", "2027-04-10T00:00:00Z"),
      )
      expect(starts(before)).toEqual(["2027-03-14T01:30:00.000Z", "2027-03-21T01:30:00.000Z"])
    })
  })
})

describe("isValidRecurrenceRule", () => {
  it("accepts the rules the editor makes", () => {
    for (const rule of [
      "FREQ=DAILY",
      "FREQ=WEEKLY;BYDAY=MO,WE",
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20270101T000000Z",
      "FREQ=MONTHLY;BYDAY=-1FR",
      "FREQ=MONTHLY;BYMONTHDAY=15;COUNT=10",
      "FREQ=MONTHLY;BYDAY=5MO",
      "FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=31",
      "FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=28",
      "FREQ=MONTHLY;INTERVAL=12;BYDAY=4TH",
      "FREQ=MONTHLY;INTERVAL=28;BYDAY=5MO",
      "FREQ=WEEKLY;WKST=SU;BYDAY=MO",
      "FREQ=YEARLY",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
    ]) {
      expect(isValidRecurrenceRule(rule), rule).toBe(true)
    }
  })

  it("stores rrule's own output without its prefix", () => {
    expect(normalizeRecurrenceRule("RRULE:FREQ=WEEKLY;BYDAY=MO")).toBe("FREQ=WEEKLY;BYDAY=MO")
    expect(normalizeRecurrenceRule("FREQ=DAILY")).toBe("FREQ=DAILY")
  })

  it("refuses rules that can never match, and shows a stored one once instead of walking it", () => {
    const never = [
      "FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=31",
      "FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=30",
      "FREQ=MONTHLY;INTERVAL=24;BYMONTHDAY=-29",
      "FREQ=MONTHLY;INTERVAL=24;BYDAY=5MO",
      "FREQ=MONTHLY;INTERVAL=112;BYDAY=-5FR",
    ]
    for (const rule of never) {
      expect(isValidRecurrenceRule(rule), rule).toBe(false)
      const stored = master({ startsAt: "2026-04-01 07:00:00", endsAt: "2026-04-01 08:00:00", recurrenceRule: rule })
      expect(expandSeries(stored, [], window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")), rule).toHaveLength(1)
    }
  })

  it("refuses rules that are unbounded in a day, unparseable or never match", () => {
    for (const rule of [
      "",
      "RRULE:",
      "DTSTART:20261019T070000Z\nRRULE:FREQ=DAILY",
      "FREQ=HOURLY",
      "FREQ=DAILY;BYHOUR=9,10",
      "FREQ=WEEKLY;BYDAY=XX",
      "FREQ=MONTHLY;BYDAY=6MO",
      "FREQ=DAILY;INTERVAL=7;BYDAY=TU",
      "FREQ=MONTHLY;BYDAY=1MO;BYMONTHDAY=31",
      "FREQ=DAILY;INTERVAL=0",
      "FREQ=DAILY;COUNT=2;UNTIL=20270101",
      "FREQ=DAILY;UNTIL=20271301",
      "FREQ=DAILY;FREQ=WEEKLY",
      "FREQ=WEEKLY;BYDAY=1MO",
      "FREQ=MONTHLY;BYDAY=0MO",
      "FREQ=WEEKLY;BYDAY=MO,XX",
      "FREQ=WEEKLY;WKST=XX",
      "FREQ=MONTHLY;BYMONTHDAY=15,32",
      "FREQ=MONTHLY;BYMONTHDAY=0",
      "FREQ=MONTHLY;BYMONTHDAY=+5",
      "FREQ=DAILY;INTERVAL=1000",
      "FREQ=DAILY;COUNT=01",
      "FREQ=DAILY;INTERVAL=2x",
      "FREQ=DAILY;UNTIL=20270230",
      "FREQ=DAILY;UNTIL=X20270101",
      "FREQ=DAILY;UNTIL=20270101T0000",
      "FREQ=DAILY;UNTIL=20270101T250000Z",
      "FREQ=DAILY;UNTIL=20270101T006000Z",
      "FREQ=DAILY;UNTIL=20270101T000060Z",
      `FREQ=WEEKLY;BYDAY=${"MO,".repeat(170)}MO`,
    ]) {
      expect(isValidRecurrenceRule(rule), rule).toBe(false)
    }
  })
})

describe("describeRecurrence", () => {
  it("puts a rule in plain words", () => {
    expect(describeRecurrence("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6")).toBe("every 2 weeks on Mon and Wed, 6 times")
    expect(describeRecurrence("FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231T225959Z")).toBe("every month on the last Fri, until 31 Dec 2026")
    expect(describeRecurrence("FREQ=DAILY")).toBe("every day")
    expect(describeRecurrence("FREQ=WEEKLY;BYDAY=MO,WE,FR")).toBe("every week on Mon, Wed and Fri")
    expect(describeRecurrence("FREQ=MONTHLY;BYMONTHDAY=1,15")).toBe("every month on day 1 and 15")
    expect(describeRecurrence("FREQ=MONTHLY;BYDAY=2TU;UNTIL=20270315")).toBe("every month on the second Tue, until 15 Mar 2027")
    expect(describeRecurrence("FREQ=HOURLY")).toBeNull()
  })
})

describe("shiftUntil", () => {
  const HOUR = 3_600_000

  it("moves a timed UNTIL with the series, floating or in UTC, and leaves a date, a missing UNTIL and a refused rule alone", () => {
    const zone = "Europe/Stockholm"
    expect(shiftUntil("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T070000Z", HOUR, zone, zone)).toBe("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T080000Z")
    expect(shiftUntil("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T090000", HOUR, zone, zone)).toBe("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T100000")
    for (const rule of ["FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019", "FREQ=DAILY", "FREQ=HOURLY;UNTIL=20261019T070000Z"]) {
      expect(shiftUntil(rule, HOUR, zone, zone)).toBe(rule)
    }
  })
})

describe("seriesTimeZone", () => {
  it("repeats all-day series and series without a known zone in UTC", () => {
    expect(seriesTimeZone({ allDay: false, recurrenceTz: "Europe/Stockholm" })).toBe("Europe/Stockholm")
    expect(seriesTimeZone({ allDay: true, recurrenceTz: "Europe/Stockholm" })).toBe("UTC")
    expect(seriesTimeZone({ allDay: false, recurrenceTz: "Mars/Olympus" })).toBe("UTC")
    expect(seriesTimeZone({ allDay: false, recurrenceTz: null })).toBe("UTC")
  })
})

describe("occurrenceFieldsOf", () => {
  it("names an override by its series and original start, a series by its first start, and a single event by its id", () => {
    expect(occurrenceFieldsOf({ id: "o1", startsAt: "2026-10-27 12:00:00", seriesId: "s1", originalStart: "2026-10-26 08:00:00" })).toEqual(
      {
        occurrence_id: "s1:2026-10-26T08:00:00.000Z",
        series_id: "s1",
        original_start: "2026-10-26T08:00:00.000Z",
      },
    )
    expect(occurrenceFieldsOf({ id: "s1", startsAt: "2026-10-19 07:00:00", recurrenceRule: "FREQ=DAILY" }).occurrence_id).toBe(
      "s1:2026-10-19T07:00:00.000Z",
    )
    expect(occurrenceFieldsOf({ id: "o2", startsAt: "2026-10-27 12:00:00", seriesId: "s1", originalStart: null }).occurrence_id).toBe("o2")
    expect(occurrenceFieldsOf({ id: "e1", startsAt: "2026-10-19 07:00:00" })).toEqual({
      occurrence_id: "e1",
      series_id: null,
      original_start: null,
    })
  })
})
