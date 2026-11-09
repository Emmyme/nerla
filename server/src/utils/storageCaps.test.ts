import { describe, expect, it } from "vitest"
import { capCheck, type Caps } from "./storageCaps"

const MB = 1024 * 1024
const caps = (set: Partial<Caps> = {}): Caps => ({ perPerson: null, total: null, maxFile: null, ceiling: 200 * MB, ...set })
const empty = { person: 0, workspace: 0 }

describe("capCheck", () => {
  it("allows anything under the ceiling with no caps", () => {
    expect(capCheck(150 * MB, { person: 900 * MB, workspace: 9000 * MB }, caps(), false)).toEqual({ ok: true })
  })

  it("refuses a file over the maximum file size with that limit", () => {
    expect(capCheck(2 * MB, empty, caps({ maxFile: MB }), false)).toEqual({ ok: false, reason: "file-too-large", limit: MB })
    expect(capCheck(MB, empty, caps({ maxFile: MB }), false)).toEqual({ ok: true })
  })

  it("enforces the ceiling when there is no maximum file size, and when the maximum is above it", () => {
    const over = 200 * MB + 1
    expect(capCheck(over, empty, caps(), false)).toEqual({ ok: false, reason: "file-too-large", limit: 200 * MB })
    expect(capCheck(over, empty, caps({ maxFile: 500 * MB }), false)).toEqual({ ok: false, reason: "file-too-large", limit: 200 * MB })
  })

  it("refuses at the per-user cap, except for a project file", () => {
    const capped = caps({ perPerson: 10 * MB })
    expect(capCheck(MB, { person: 9 * MB, workspace: 0 }, capped, false)).toEqual({ ok: true })
    expect(capCheck(MB + 1, { person: 9 * MB, workspace: 0 }, capped, false)).toEqual({
      ok: false,
      reason: "person-full",
      limit: 10 * MB,
    })
    expect(capCheck(MB + 1, { person: 9 * MB, workspace: 0 }, capped, true)).toEqual({ ok: true })
  })

  it("refuses at the workspace total, project files included", () => {
    const capped = caps({ total: 100 * MB })
    const refused = { ok: false, reason: "workspace-full", limit: 100 * MB }
    expect(capCheck(2 * MB, { person: 0, workspace: 99 * MB }, capped, false)).toEqual(refused)
    expect(capCheck(2 * MB, { person: 0, workspace: 99 * MB }, capped, true)).toEqual(refused)
  })
})
