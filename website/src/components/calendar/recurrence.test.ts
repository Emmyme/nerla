import { describe, expect, it } from "vitest"
import { customFrom, customRule, followStart, monthlyPosition, presetLabel, presetOf, presetRule } from "./recurrence"

// Friday 23 October 2026, 09:00
const friday = new Date(2026, 9, 23, 9)

describe("presetRule", () => {
  it("builds each preset from the start", () => {
    expect(presetRule("none", friday)).toBeNull()
    expect(presetRule("daily", friday)).toBe("FREQ=DAILY")
    expect(presetRule("weekly", friday)).toBe("FREQ=WEEKLY;BYDAY=FR")
    expect(presetRule("monthly", friday)).toBe("FREQ=MONTHLY;BYDAY=4FR")
    expect(presetRule("yearly", friday)).toBe("FREQ=YEARLY")
    expect(presetRule("weekdays", friday)).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")
  })

  it("uses the last weekday when the fifth would not come every month", () => {
    expect(monthlyPosition(new Date(2026, 9, 29))).toBe(-1)
    expect(presetRule("monthly", new Date(2026, 9, 31))).toBe("FREQ=MONTHLY;BYDAY=-1SA")
    expect(monthlyPosition(new Date(2026, 9, 25))).toBe(4)
    expect(monthlyPosition(new Date(2026, 9, 1))).toBe(1)
  })

  it("labels the presets", () => {
    expect(presetLabel("weekly", friday)).toBe("Weekly on Friday")
    expect(presetLabel("monthly", friday)).toBe("Monthly on the fourth Friday")
    expect(presetLabel("monthly", new Date(2026, 9, 30))).toBe("Monthly on the last Friday")
    expect(presetLabel("yearly", friday)).toBe("Annually on 23 October")
    expect(presetLabel("weekdays", friday)).toBe("Every weekday (Mon to Fri)")
  })
})

describe("customRule", () => {
  it("builds an interval with weekdays and a count", () => {
    expect(customRule({ freq: "WEEKLY", interval: 2, weekdays: ["TH", "MO"], end: { kind: "after", count: 10 } }, friday)).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=10",
    )
  })

  it("falls back to the start's weekday and ends on a date", () => {
    expect(customRule({ freq: "WEEKLY", interval: 1, weekdays: [], end: { kind: "on", date: new Date(2026, 11, 31) } }, friday)).toBe(
      "FREQ=WEEKLY;BYDAY=FR;UNTIL=20261231",
    )
  })

  it("repeats days, months and years every N", () => {
    expect(customRule({ freq: "DAILY", interval: 3, weekdays: [], end: { kind: "never" } }, friday)).toBe("FREQ=DAILY;INTERVAL=3")
    expect(customRule({ freq: "MONTHLY", interval: 2, weekdays: ["MO"], end: { kind: "never" } }, friday)).toBe(
      "FREQ=MONTHLY;INTERVAL=2;BYDAY=4FR",
    )
    expect(customRule({ freq: "YEARLY", interval: 1, weekdays: [], end: { kind: "after", count: 5 } }, friday)).toBe("FREQ=YEARLY;COUNT=5")
  })

  it("keeps interval and count in the range the server takes", () => {
    expect(customRule({ freq: "DAILY", interval: 0, weekdays: [], end: { kind: "after", count: 5000 } }, friday)).toBe(
      "FREQ=DAILY;COUNT=999",
    )
  })
})

describe("reading a rule back", () => {
  it("names presets and parses custom rules", () => {
    expect(presetOf(null, friday)).toBe("none")
    expect(presetOf("FREQ=WEEKLY;BYDAY=FR", friday)).toBe("weekly")
    expect(presetOf("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", friday)).toBe("weekdays")
    expect(presetOf("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=10", friday)).toBe("custom")
    expect(customFrom("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20261231", friday)).toEqual({
      freq: "WEEKLY",
      interval: 2,
      weekdays: ["MO", "TH"],
      end: { kind: "on", date: new Date(2026, 11, 31) },
    })
  })

  it("moves a weekday rule along with the start", () => {
    const monday = new Date(2026, 9, 26, 9)
    expect(followStart("FREQ=WEEKLY;BYDAY=FR", friday, monday)).toBe("FREQ=WEEKLY;BYDAY=MO")
    expect(followStart("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", friday, monday)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH")
    expect(followStart("FREQ=MONTHLY;BYMONTHDAY=5", friday, monday)).toBe("FREQ=MONTHLY;BYMONTHDAY=5")
  })
})
