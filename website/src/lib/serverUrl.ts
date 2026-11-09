import { isTauri } from "@tauri-apps/api/core"
import { probeOutcome, type ProbeResult } from "@/lib/authFlow"
import { getStore, removeToken } from "@/lib/authToken"

const STORAGE_KEY = "nerla_server_url"
const STORE_KEY = "server_url"
const DEFAULT_URL = "http://localhost:5000"

const ALLOWED_PROTOCOLS = ["http:", "https:"]

/** Keeps only scheme, host and port, so a pasted URL cannot smuggle a path. */
function validateAndNormalize(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) throw new Error("Server URL is required")

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error("Invalid URL format")
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error("Only http:// and https:// URLs are allowed")
  }

  if (!parsed.hostname) {
    throw new Error("URL must include a hostname")
  }

  const port = parsed.port ? `:${parsed.port}` : ""
  return `${parsed.protocol}//${parsed.hostname}${port}`
}

/** Returns true when the URL uses plain http:// and isn't a loopback address. */
export function isInsecureUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:") return false
    const host = parsed.hostname
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1"
  } catch {
    return false
  }
}

/** Probes /api/auth/setup-status to check the URL is a Nerla server. A 429 counts as reachable but busy. */
export async function verifyNerlaServer(baseUrl: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`${baseUrl}/api/auth/setup-status`, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    })
    const data = res.ok ? await res.json().catch(() => null) : null
    return probeOutcome(res.status, res.headers.get("Retry-After"), data)
  } catch {
    return { ok: false, reason: "Couldn't reach that address. Check the URL and that the server is running." }
  }
}

/** The web image carries no address, so a browser build talks to the origin it was served from */
function builtInUrl(): string {
  return import.meta.env.VITE_API_URL?.replace(/\/api\/?$/, "") || (isTauri() ? DEFAULT_URL : window.location.origin)
}

export async function getServerUrl(): Promise<string> {
  if (typeof window === "undefined") return DEFAULT_URL

  if (isTauri()) {
    const store = await getStore()
    if (store) {
      const v = await store.get<string>(STORE_KEY)
      if (v) return v
    }
  }

  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) return stored

  return builtInUrl()
}

/**
 * Validate, normalize, and persist the server URL.
 * Throws if the URL is invalid or uses a disallowed protocol.
 */
export async function setServerUrl(url: string): Promise<string> {
  const normalized = validateAndNormalize(url)
  // A token belongs to the server that issued it, so another address signs out first
  if (normalized !== (await getServerUrl())) await removeToken()

  if (isTauri()) {
    const store = await getStore()
    if (store) {
      await store.set(STORE_KEY, normalized)
      await store.save()
    }
  }

  localStorage.setItem(STORAGE_KEY, normalized)
  return normalized
}

export function getServerUrlSync(): string {
  if (typeof window === "undefined") return DEFAULT_URL
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) return stored
  return builtInUrl()
}

export function getApiBaseUrl(): string {
  return `${getServerUrlSync()}/api`
}

export function getWsBaseUrl(): string {
  return (
    getServerUrlSync()
      // Plain-text WebSocket only arises from an http origin (local/dev), an https
      // origin is upgraded to a secure WebSocket on the next line.
      .replace("http://", "ws://") // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
      .replace("https://", "wss://")
  )
}
