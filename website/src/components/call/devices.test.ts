import { afterEach, describe, expect, it, vi } from "vitest"
import { deviceProblem, loadChoices, rejoinChoices, saveChoices } from "./devices"

describe("deviceProblem", () => {
  it("maps each media error name to its copy", () => {
    expect(deviceProblem(new DOMException("denied", "NotAllowedError"))).toBe(
      "Your camera and microphone are blocked. Allow them in your browser, or join without them.",
    )
    expect(deviceProblem(new DOMException("none", "NotFoundError"))).toBe("No camera or microphone found. You can still join and listen.")
    expect(deviceProblem(new DOMException("busy", "NotReadableError"))).toBe("Your camera or microphone is in use by another app.")
    expect(deviceProblem(new Error("boom"))).toBe("Something went wrong with your camera or microphone.")
    expect(deviceProblem("odd")).toBe("Something went wrong with your camera or microphone.")
  })

  it("gives null for no error", () => {
    expect(deviceProblem(null)).toBeNull()
  })
})

describe("loadChoices", () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ["holds broken JSON", { getItem: () => "{broken", setItem: () => {} }],
    ["is missing", undefined],
  ])("falls back to both on when storage %s", (_name, storage) => {
    if (storage) vi.stubGlobal("localStorage", storage)
    expect(loadChoices()).toEqual({ audioEnabled: true, videoEnabled: true })
  })

  it("reads back what was saved", () => {
    const store = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    })
    saveChoices({ audioEnabled: false, videoEnabled: true, videoDeviceId: "cam-2" })
    expect(store.has("nerla-call-devices")).toBe(true)
    expect(loadChoices()).toEqual({ audioEnabled: false, videoEnabled: true, videoDeviceId: "cam-2" })
  })
})

describe("rejoinChoices", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("keeps a device switched mid-call and the mic and camera as they were at the end", () => {
    const saved = JSON.stringify({ audioEnabled: true, videoEnabled: true, audioDeviceId: "mic-2", videoDeviceId: "cam-2" })
    vi.stubGlobal("localStorage", { getItem: () => saved, setItem: () => {} })
    const joined = { audioEnabled: true, videoEnabled: true, audioDeviceId: "mic-1", videoDeviceId: "cam-1" }
    expect(rejoinChoices(joined, { audioEnabled: false, videoEnabled: true })).toEqual({
      audioEnabled: false,
      videoEnabled: true,
      audioDeviceId: "mic-2",
      videoDeviceId: "cam-2",
    })
  })

  it("keeps the join devices when nothing was saved", () => {
    const joined = { audioEnabled: true, videoEnabled: false, audioDeviceId: "mic-1" }
    expect(rejoinChoices(joined)).toEqual(joined)
  })
})
