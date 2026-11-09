import { describe, expect, it } from "vitest"
import { mediaShortcut } from "./shortcuts"

const press = (key: string, mods: Partial<KeyboardEvent> = {}, target: unknown = null) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target, ...mods }) as Parameters<typeof mediaShortcut>[0]

describe("mediaShortcut", () => {
  it("maps Ctrl elsewhere and Cmd on a Mac to the mic and camera", () => {
    expect(mediaShortcut(press("d", { ctrlKey: true }), false)).toBe("mic")
    expect(mediaShortcut(press("E", { ctrlKey: true }), false)).toBe("camera")
    expect(mediaShortcut(press("e", { metaKey: true }), true)).toBe("camera")
    expect(mediaShortcut(press("e", { ctrlKey: true }), true)).toBeNull()
    expect(mediaShortcut(press("e", { metaKey: true }), false)).toBeNull()
    expect(mediaShortcut(press("e", { ctrlKey: true, shiftKey: true }), false)).toBeNull()
  })

  it("leaves typing alone", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"])
      expect(mediaShortcut(press("e", { ctrlKey: true }, { tagName, isContentEditable: false }), false)).toBeNull()
    expect(mediaShortcut(press("d", { ctrlKey: true }, { tagName: "DIV", isContentEditable: true }), false)).toBeNull()
    expect(mediaShortcut(press("d", { ctrlKey: true }, { tagName: "BUTTON", isContentEditable: false }), false)).toBe("mic")
  })
})
