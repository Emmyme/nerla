// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({ value: false }))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => tauri.value }))

import { getServerUrl, getServerUrlSync } from "./serverUrl"

afterEach(() => {
  tauri.value = false
  localStorage.clear()
  vi.unstubAllEnvs()
})

describe("server url", () => {
  it("is the page's own origin in a browser build with no VITE_API_URL", async () => {
    vi.stubEnv("VITE_API_URL", "")
    expect(getServerUrlSync()).toBe(window.location.origin)
    expect(await getServerUrl()).toBe(window.location.origin)
  })

  it("keeps the localhost default in Tauri", () => {
    vi.stubEnv("VITE_API_URL", "")
    tauri.value = true
    expect(getServerUrlSync()).toBe("http://localhost:5000")
  })

  it("uses VITE_API_URL without its /api suffix when set", () => {
    vi.stubEnv("VITE_API_URL", "http://localhost:5000/api")
    expect(getServerUrlSync()).toBe("http://localhost:5000")
  })

  it("lets a stored url win", () => {
    vi.stubEnv("VITE_API_URL", "")
    localStorage.setItem("nerla_server_url", "https://stored.example.com")
    expect(getServerUrlSync()).toBe("https://stored.example.com")
  })
})
