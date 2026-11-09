// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { ApiError } from "@/lib/api/request"
import type { TimerDto } from "@/lib/api/time"
import { startupRetryMs } from "@/lib/useBusyRetry"

const state = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/time", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/time")>()),
  timeAPI: { state },
}))

import {
  applyTimeEvent,
  startTimeTracking,
  useTimeTracking,
  useTimeTrackingReady,
  useTimeTrackingRetrying,
  type TimeTracking,
} from "./timeStore"

const timer: TimerDto = {
  startedAt: "2026-10-27T08:00:00.000Z",
  project: { id: "p1", name: "Website", color: null },
  task: null,
  note: null,
}
const on: TimeTracking = { enabled: true, timer: null, canReport: true, autofillProjectId: "p1" }

describe("time events", () => {
  it("sets the timer, and clears it when the timer is null", () => {
    const running = applyTimeEvent(on, { type: "time:timer", timer, stopped: null })
    expect(running.timer).toEqual(timer)
    expect(applyTimeEvent(running, { type: "time:timer", timer: null, stopped: null }).timer).toBeNull()
  })

  it("hides everything when the workspace turns time tracking off, and shows no timer that starts after", () => {
    const running = applyTimeEvent(on, { type: "time:timer", timer, stopped: null })
    const off = applyTimeEvent(running, { type: "time:enabled", enabled: false })
    expect(off).toEqual({ enabled: false, timer: null, canReport: false, autofillProjectId: null })
    expect(applyTimeEvent(off, { type: "time:timer", timer, stopped: null }).timer).toBeNull()
  })
})

describe("the startup check", () => {
  afterEach(() => vi.useRealTimers())

  it("waits after a failure and asks again, ending with time tracking on", async () => {
    vi.useFakeTimers()
    state.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce({ ...on, checks: [] })
    const { result } = renderHook(() => ({
      tracking: useTimeTracking(),
      ready: useTimeTrackingReady(),
      retrying: useTimeTrackingRetrying(),
    }))
    const stop = startTimeTracking()

    await act(() => vi.advanceTimersByTimeAsync(4999))
    expect(result.current).toMatchObject({ tracking: { enabled: false }, ready: false, retrying: true })
    expect(state).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(state).toHaveBeenCalledTimes(2)
    expect(result.current).toMatchObject({ tracking: { enabled: true }, ready: true, retrying: false })
    act(() => stop())

    expect([0, 1, 2, 3].map((attempt) => startupRetryMs(new TypeError("Failed to fetch"), attempt))).toEqual([5000, 15000, 60000, 60000])
    expect(startupRetryMs(new ApiError(429, {}, "2"), 0)).toBe(2000)
  })
})
