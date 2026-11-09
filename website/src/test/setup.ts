import { afterEach, vi } from "vitest"

// No test reaches the network. A request a test has not stubbed itself is answered as signed out.
globalThis.fetch = vi.fn(async () => Response.json({ error: "Unauthorized" }, { status: 401 }))

if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest")
  const { cleanup } = await import("@testing-library/react")
  afterEach(() => {
    cleanup()
  })

  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.scrollIntoView ??= () => {}

  // Node's Request only accepts its own AbortSignal, and react-router passes the jsdom one on every navigation
  const NodeRequest = globalThis.Request
  globalThis.Request = class Request extends NodeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init?.signal ? { ...init, signal: undefined } : init)
      if (init?.signal) Object.defineProperty(this, "signal", { value: init.signal })
    }
  }
}
