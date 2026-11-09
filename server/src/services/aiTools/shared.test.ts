import { describe, expect, it, vi } from "vitest"

vi.mock("../../db", async () => ({ ...(await import("../../db/schema")), db: {} }))

import { toInstant } from "./shared"

describe("toInstant", () => {
  it("reads a local time in the zone across the October change", () => {
    expect(toInstant("2026-10-23T15:00", "Europe/Stockholm")).toBe("2026-10-23T13:00:00.000Z")
    expect(toInstant("2026-10-30T15:00:00", "Europe/Stockholm")).toBe("2026-10-30T14:00:00.000Z")
    expect(toInstant("2026-10-25T02:30", "Europe/Stockholm")).toBe("2026-10-25T00:30:00.000Z")
  })

  it("keeps a time with a zone, a date and anything it can't read", () => {
    expect(toInstant("2026-10-30T15:00:00+01:00", "Europe/Stockholm")).toBe("2026-10-30T15:00:00+01:00")
    expect(toInstant("2026-10-30T15:00Z", "Europe/Stockholm")).toBe("2026-10-30T15:00Z")
    expect(toInstant("2026-10-30", "Europe/Stockholm")).toBe("2026-10-30")
    expect(toInstant("2026-02-30T15:00", "Europe/Stockholm")).toBe("2026-02-30T15:00")
  })
})
