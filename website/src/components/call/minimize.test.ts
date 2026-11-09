import { describe, expect, it } from "vitest"
import { minimizeAction } from "./minimize"

describe("minimizeAction", () => {
  it("sends a desktop call to the corner and lets the corner window minimize", () => {
    expect(minimizeAction({ inCall: true, mini: false, tauri: true })).toBe("mini")
    expect(minimizeAction({ inCall: true, mini: true, tauri: true })).toBe("minimize")
    expect(minimizeAction({ inCall: false, mini: false, tauri: true })).toBe("minimize")
  })

  it("does nothing on the web", () => {
    expect(minimizeAction({ inCall: true, mini: false, tauri: false })).toBe("none")
  })
})
