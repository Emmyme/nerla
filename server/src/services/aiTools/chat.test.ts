import { describe, expect, it, vi } from "vitest"

vi.mock("../../db", async () => ({ ...(await import("../../db/schema")), db: {} }))
vi.mock("../storage", () => ({}))

import { pageWithin, sinceInstant } from "./chat"

describe("read_chat ranges", () => {
  it("turns since into a cutoff in the asker's zone", () => {
    expect(sinceInstant("2026-11-02", "Europe/Stockholm")).toBe("2026-11-01T23:00:00.000Z")
    expect(sinceInstant("2026-11-02T09:30", "Europe/Stockholm")).toBe("2026-11-02T08:30:00.000Z")
    expect(sinceInstant("2026-11-02T09:30:15.250", "Europe/Stockholm")).toBe("2026-11-02T08:30:15.000Z")
    expect(sinceInstant("last week", "Europe/Stockholm")).toBeNull()
  })

  it("stops at the request's cap", () => {
    expect(pageWithin(180, 50)).toBe(20)
    expect(pageWithin(200, 50)).toBe(0)
  })
})
