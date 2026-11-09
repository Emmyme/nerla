import { describe, expect, it, vi } from "vitest"

const rows = [{ timeZone: "Europe/Stockholm" }]
vi.mock("../../db", async () => ({
  ...(await import("../../db/schema")),
  db: { select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }) },
}))
vi.mock("../storage", () => ({}))

import { eventTimes } from "./calendar"
import type { ToolContext } from "./shared"

const ctx = { askerId: "u1" } as ToolContext

describe("eventTimes", () => {
  it("makes two dates an all-day event with an inclusive end and no zone shift", async () => {
    expect(await eventTimes(ctx, { start: "2026-10-30", end: "2026-10-31" })).toEqual({
      start: "2026-10-30T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
      allDay: true,
      zone: "Europe/Stockholm",
    })
  })

  it("explains a last day before the first", async () => {
    expect(await eventTimes(ctx, { start: "2026-10-31", end: "2026-10-30" })).toEqual({ error: "The last day comes before the first day" })
  })

  it("reads local times in the user's zone", async () => {
    expect(await eventTimes(ctx, { start: "2026-10-30T15:00", end: "2026-10-30T16:00" })).toMatchObject({
      start: "2026-10-30T14:00:00.000Z",
      allDay: false,
    })
  })
})
