import { describe, expect, it } from "vitest"
import { autoFillMinutes, canEditEntry, canSeeEntry, capTimer, csvRow, isLocked, localDate, pickSuggestions, taskNamed } from "./timeRules"

const at = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
const span = (start: string, end: string) => ({ start: at(start), end: at(end) })

const OWNER = "u-owner"
const entry = { userId: OWNER, projectId: "p1", taskId: null, detached: false, date: "2026-10-20" }
const viewer = (over: Partial<{ userId: string; isOrgAdmin: boolean; adminProjectIds: Set<string> }> = {}) => ({
  userId: "u-other",
  isOrgAdmin: false,
  adminProjectIds: new Set<string>(),
  ...over,
})

describe("localDate", () => {
  it("dates an instant in the user's zone, and in UTC without one", () => {
    expect(localDate(new Date("2026-10-26T23:30:00Z"), "Europe/Stockholm")).toBe("2026-10-27")
    expect(localDate(new Date("2026-10-26T23:30:00Z"), null)).toBe("2026-10-26")
    expect(localDate(new Date("2026-10-26T23:30:00Z"), "Mars/Olympus")).toBe("2026-10-26")
  })
})

describe("isLocked", () => {
  it("locks the lock date itself and never a personal entry", () => {
    expect(isLocked({ projectId: "p", date: "2026-10-31" }, "2026-10-31")).toBe(true)
    expect(isLocked({ projectId: "p", date: "2026-11-01" }, "2026-10-31")).toBe(false)
    expect(isLocked({ projectId: null, date: "2026-10-01" }, "2026-10-31")).toBe(false)
  })

  it("keeps a detached entry locked once its project is gone", () => {
    expect(isLocked({ projectId: null, date: "2026-10-01", detached: true }, null)).toBe(true)
  })
})

describe("canSeeEntry", () => {
  it("shows an entry to its owner, its project's admins and workspace admins only", () => {
    expect(canSeeEntry(entry, viewer({ userId: OWNER }))).toBe(true)
    expect(canSeeEntry(entry, viewer())).toBe(false)
    expect(canSeeEntry(entry, viewer({ adminProjectIds: new Set(["p1"]) }))).toBe(true)
    expect(canSeeEntry({ ...entry, projectId: "p2" }, viewer({ adminProjectIds: new Set(["p1"]) }))).toBe(false)
    expect(canSeeEntry(entry, viewer({ isOrgAdmin: true }))).toBe(true)
    expect(canSeeEntry({ ...entry, projectId: null, detached: true }, viewer({ isOrgAdmin: true }))).toBe(true)
  })

  it("shows a detached entry to workspace admins only, apart from its owner", () => {
    const detached = { ...entry, projectId: null, detached: true }
    expect(canSeeEntry(detached, viewer({ isOrgAdmin: true }))).toBe(true)
    expect(canSeeEntry(detached, viewer({ adminProjectIds: new Set(["p1"]) }))).toBe(false)
    expect(canSeeEntry(detached, viewer())).toBe(false)
  })

  it("shows a personal entry to nobody but its owner", () => {
    const personal = { ...entry, projectId: null, taskId: "t1", detached: false }
    expect(canSeeEntry(personal, viewer({ userId: OWNER }))).toBe(true)
    expect(canSeeEntry(personal, viewer({ isOrgAdmin: true, adminProjectIds: new Set(["p1"]) }))).toBe(false)
  })
})

describe("canEditEntry", () => {
  const member = { userId: OWNER, memberProjectIds: new Set(["p1"]) }

  it("lets only the owner change an unlocked entry on a project they are still in", () => {
    expect(canEditEntry(entry, { userId: "u-other", memberProjectIds: new Set(["p1"]) }, null)).toBe("hidden")
    expect(canEditEntry(entry, member, "2026-10-20")).toBe("locked")
    expect(canEditEntry(entry, member, null, { date: "2026-10-31", lockedUntil: "2026-10-31" })).toBe("locked")
    expect(canEditEntry(entry, member, null, { date: "2026-11-01", lockedUntil: "2026-10-31" })).toBe("ok")
    expect(canEditEntry(entry, { userId: OWNER, memberProjectIds: new Set() }, null)).toBe("read-only")
    expect(canEditEntry(entry, member, null)).toBe("ok")
  })
})

describe("autoFillMinutes", () => {
  const day = { window: span("08:00", "17:00"), breaks: [span("12:00", "13:00")], away: [], otherMinutes: 0 }

  it("fills the working window minus breaks, time away and other time", () => {
    expect(autoFillMinutes(day)).toBe(480)
    expect(autoFillMinutes({ ...day, otherMinutes: 90 })).toBe(390)
    expect(autoFillMinutes({ ...day, away: [span("08:00", "17:00")] })).toBe(0)
    expect(autoFillMinutes({ ...day, away: [span("13:00", "17:00")] })).toBe(240)
    expect(autoFillMinutes({ ...day, window: null })).toBe(0)
    expect(autoFillMinutes({ ...day, away: [span("18:00", "19:00")] })).toBe(480)
  })

  it("subtracts a break inside time away only once", () => {
    expect(autoFillMinutes({ ...day, away: [span("11:00", "14:00")] })).toBe(360)
  })
})

describe("capTimer", () => {
  it("caps a timer that ran over 600 minutes at exactly 600", () => {
    const now = new Date("2026-10-27T20:00:00.000Z")
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString()
    expect(capTimer(ago(599), now)).toEqual({ minutes: 599, capped: false })
    expect(capTimer(ago(600), now)).toEqual({ minutes: 600, capped: false })
    expect(capTimer(ago(601), now)).toEqual({ minutes: 600, capped: true })
  })
})

describe("pickSuggestions", () => {
  const day = "2026-10-20"
  const meeting = { key: "meeting:e1:2026-10-20T09:00:00.000Z", kind: "meeting" as const, date: day, projectId: null, taskId: null }
  const task = { key: `task:t1:${day}`, kind: "task" as const, date: day, projectId: "p1", taskId: "t1" }
  const repeat = { key: `repeat:x1:${day}`, kind: "repeat" as const, date: day, projectId: "p2", taskId: null }
  const seen = (over: Partial<Parameters<typeof pickSuggestions>[1]> = {}) => ({
    dismissed: new Set<string>(),
    usedKeys: new Set<string>(),
    loggedTaskIds: new Set<string>(),
    loggedProjectIds: new Set<string>(),
    today: day,
    ...over,
  })
  const keys = (list: { key: string }[]) => list.map((item) => item.key)

  it("drops dismissed and used keys", () => {
    expect(keys(pickSuggestions([meeting, task, repeat], seen()))).toEqual([meeting.key, task.key, repeat.key])
    expect(
      keys(pickSuggestions([meeting, task, repeat], seen({ dismissed: new Set([meeting.key]), usedKeys: new Set([repeat.key]) }))),
    ).toEqual([task.key])
  })

  it("drops a task already logged that day, and a repeat whose project has time that day", () => {
    expect(keys(pickSuggestions([meeting, task, repeat], seen({ loggedTaskIds: new Set(["t1"]) })))).toEqual([meeting.key, repeat.key])
    expect(keys(pickSuggestions([meeting, task, repeat], seen({ loggedProjectIds: new Set(["p1", "p2"]) })))).toEqual([
      meeting.key,
      task.key,
    ])
  })

  it("drops a repeat of a personal task that already has time that day", () => {
    const personal = { ...repeat, key: "repeat:x2", projectId: null, taskId: "t9" }
    expect(pickSuggestions([personal], seen({ loggedTaskIds: new Set(["t9"]) }))).toEqual([])
    expect(pickSuggestions([personal], seen())).toEqual([personal])
  })

  it("drops anything after today", () => {
    expect(pickSuggestions([meeting, task, repeat], seen({ today: "2026-10-19" }))).toEqual([])
  })
})

describe("taskNamed", () => {
  const task = (over: Partial<Parameters<typeof taskNamed>[0]> = {}) => ({ projectId: "p1", assignedTo: null, isMember: false, ...over })

  it("keeps the name while the task sits in the time's own project, even after leaving it", () => {
    expect(taskNamed(task(), "p1", "u1")).toBe(true)
  })

  it("hides a task moved to a project the user is not in, and another user's personal task", () => {
    expect(taskNamed(task({ projectId: "p2" }), "p1", "u1")).toBe(false)
    expect(taskNamed(task({ projectId: "p2", isMember: true }), "p1", "u1")).toBe(true)
    expect(taskNamed(task({ projectId: null, assignedTo: "u2" }), "p1", "u1")).toBe(false)
    expect(taskNamed(task({ projectId: null, assignedTo: "u1" }), null, "u1")).toBe(true)
    expect(taskNamed(task({ projectId: null, assignedTo: "u2" }), null, "u1")).toBe(false)
  })
})

describe("csvRow", () => {
  it("defuses a formula only at the start of a value", () => {
    expect(csvRow(["+1", "-2", "@x", "a=b"])).toBe("'+1,'-2,'@x,a=b")
  })

  it("quotes commas, quotes and newlines, defuses formulas and keeps å, ä and ö", () => {
    expect(csvRow(["a,b", 'say "hi"', "two\nlines", "=SUM(A1)", "Åsa"])).toBe('"a,b","say ""hi""","two\nlines",\'=SUM(A1),Åsa')
  })
})
