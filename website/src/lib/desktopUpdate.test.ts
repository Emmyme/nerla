import { afterEach, describe, expect, it, vi } from "vitest"

const { check, relaunch, toast } = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn() }),
}))
let call = false

vi.mock("@tauri-apps/plugin-updater", () => ({ check }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }))
vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/socket", () => ({ inCall: () => call }))

import { startDesktopUpdateCheck } from "@/lib/desktopUpdate"

const fakeUpdate = () => ({
  version: "1.2.0",
  download: vi.fn().mockResolvedValue(undefined),
  install: vi.fn().mockResolvedValue(undefined),
})
const restartAction = () => toast.mock.calls[0][1].action.onClick as () => void

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  call = false
})

describe("startDesktopUpdateCheck", () => {
  it("shows nothing when there is no update", async () => {
    check.mockResolvedValue(null)
    await startDesktopUpdateCheck()
    expect(toast).not.toHaveBeenCalled()
  })

  it("downloads an update, then offers a restart that installs and relaunches", async () => {
    const update = fakeUpdate()
    check.mockResolvedValue(update)
    await startDesktopUpdateCheck()
    expect(update.download).toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith("Nerla 1.2.0 is ready.", expect.anything())
    restartAction()()
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalled())
    expect(update.install).toHaveBeenCalled()
  })

  it("waits for a call to end before it restarts", async () => {
    vi.useFakeTimers()
    const update = fakeUpdate()
    check.mockResolvedValue(update)
    await startDesktopUpdateCheck()
    call = true
    restartAction()()
    expect(toast.info).toHaveBeenCalledWith("It restarts when the call ends.")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(update.install).not.toHaveBeenCalled()
    call = false
    await vi.advanceTimersByTimeAsync(3000)
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalled())
  })

  it("logs one warning and shows nothing when the check throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    check.mockRejectedValue(new Error("offline"))
    await startDesktopUpdateCheck()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(toast).not.toHaveBeenCalled()
    expect(check).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
