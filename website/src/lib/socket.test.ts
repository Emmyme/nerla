import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { disconnectSocket, initializeSocket, onSocketReconnect, reconnectDelay } from "./socket"

describe("reconnectDelay", () => {
  it("backs off 1s, 2s, 4s and stays at 30s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  })
})

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static all: FakeSocket[] = []
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  constructor() {
    FakeSocket.all.push(this)
  }
  send() {}
  close() {
    this.readyState = FakeSocket.CLOSED
  }
  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  signIn() {
    this.onmessage?.({ data: JSON.stringify({ type: "auth_success", organizationId: "org-1" }) })
  }
  drop() {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }
}

describe("catching up after a reconnect", () => {
  const caughtUp = vi.fn()
  let off = () => {}

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.stubGlobal("WebSocket", FakeSocket)
    FakeSocket.all = []
    caughtUp.mockReset()
    off = onSocketReconnect(caughtUp)
  })

  afterEach(() => {
    off()
    disconnectSocket()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const next = () => {
    vi.advanceTimersByTime(1000)
    return FakeSocket.all.at(-1)!
  }

  it("waits for the sign-in after a drop, and stays quiet on the first one", () => {
    initializeSocket()
    const first = FakeSocket.all[0]
    first.open()
    first.signIn()
    expect(caughtUp).not.toHaveBeenCalled()

    first.drop()
    const second = next()
    second.open()
    expect(caughtUp).not.toHaveBeenCalled()
    second.signIn()
    expect(caughtUp).toHaveBeenCalledTimes(1)
  })

  it("catches up when the first try failed", () => {
    initializeSocket()
    FakeSocket.all[0].drop()
    const second = next()
    second.open()
    second.signIn()
    expect(caughtUp).toHaveBeenCalledTimes(1)
  })
})
