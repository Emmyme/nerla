import { describe, expect, it } from "vitest"
import type { TimeEntry, TimeWeek } from "@/lib/api/time"
import { applyToWeek, presetRange } from "./timeView"

const entry = (id: string, date: string, minutes: number): TimeEntry => ({
  id,
  date,
  minutes,
  note: null,
  source: "manual",
  project: { id: "p1", name: "Website", color: null },
  deletedProjectName: null,
  task: null,
  taskLabel: null,
  locked: false,
  needsCheck: false,
  auto: false,
  edited: false,
})

const suggestion = {
  key: "meeting:e1:2026-10-27T09:00:00.000Z",
  kind: "meeting" as const,
  date: "2026-10-27",
  minutes: 30,
  title: "Standup",
  project: null,
  task: null,
  needsProject: true,
}

const week: TimeWeek = {
  start: "2026-10-26",
  days: [
    { date: "2026-10-26", entries: [entry("a", "2026-10-26", 60), entry("b", "2026-10-26", 30)], suggestions: [], minutes: 90 },
    { date: "2026-10-27", entries: [], suggestions: [suggestion], minutes: 0 },
  ],
  minutes: 90,
  lockedUntil: {},
}

describe("the week after a write", () => {
  it("moves an edited entry to its new day, drops a used suggestion and adds up again", () => {
    const moved = applyToWeek(week, { entry: entry("a", "2026-10-27", 45), suggestionKey: suggestion.key })
    expect(moved.days[0].entries.map((e) => e.id)).toEqual(["b"])
    expect(moved.days[1].entries.map((e) => e.id)).toEqual(["a"])
    expect(moved.days[1].suggestions).toEqual([])
    expect([moved.days[0].minutes, moved.days[1].minutes, moved.minutes]).toEqual([30, 45, 75])
    expect(applyToWeek(week, { entry: entry("a", "2026-10-26", 15) }).days[0].entries.map((e) => [e.id, e.minutes])).toEqual([
      ["a", 15],
      ["b", 30],
    ])
    expect(applyToWeek(week, { removedId: "b" }).minutes).toBe(60)
  })
})

describe("report presets", () => {
  it("reads weeks from Monday and months across a new year", () => {
    expect(presetRange("this-week", "2026-11-01")).toEqual({ from: "2026-10-26", to: "2026-11-01" })
    expect(presetRange("last-week", "2026-10-27")).toEqual({ from: "2026-10-19", to: "2026-10-25" })
    expect(presetRange("this-month", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" })
    expect(presetRange("last-month", "2027-01-15")).toEqual({ from: "2026-12-01", to: "2026-12-31" })
  })
})
