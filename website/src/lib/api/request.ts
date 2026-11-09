import { isTauri } from "@tauri-apps/api/core"
import { getToken, removeToken } from "@/lib/authToken"
import { getApiBaseUrl } from "@/lib/serverUrl"
import { signInPath } from "@/lib/signInReturn"
import { loadApp } from "@/lib/appPath"

export class ApiError extends Error {
  status: number
  data: Record<string, unknown>
  /** The server's own message, null when the response carried none */
  serverMessage: string | null
  /** The Retry-After header of a 429, null otherwise */
  retryAfter: string | null
  constructor(status: number, data: Record<string, unknown>, retryAfter: string | null = null) {
    const found = typeof data?.error === "string" && data.error.trim() !== "" ? data.error : undefined
    super(found ?? `Request failed with status ${status}`)
    this.status = status
    this.data = data
    this.serverMessage = found ?? null
    this.retryAfter = retryAfter
  }
}

/** Only the desktop app receives the JWT in a body, the website uses the cookie. */
export function clientHeaders(): Record<string, string> {
  return isTauri() ? { "X-Nerla-Client": "desktop" } : {}
}

/** The server's refusal for a change in a project the caller only reads, READ_ONLY in server/src/routes/helpers.ts */
const READ_ONLY_REFUSAL = "Join this project to make changes"
export const PROJECT_READ_ONLY_EVENT = "nerla:project-read-only"

/** Tells an open project page that the caller lost membership, so it reloads and turns read-only */
export function noticeReadOnly(status: number, data: Record<string, unknown>) {
  if (status === 403 && data?.error === READ_ONLY_REFUSAL && typeof window !== "undefined") {
    window.dispatchEvent(new Event(PROJECT_READ_ONLY_EVENT))
  }
}

/** A lost session clears the token and goes to sign-in, except on pages users reach without one */
export async function handleUnauthorized(): Promise<void> {
  await removeToken()
  // Guests on the public join and link pages have no session, so a 401 there is expected
  const route = typeof window === "undefined" ? "" : isTauri() ? window.location.hash.slice(1) : window.location.pathname
  const publicPage = ["/sign-in", "/join/", "/s/"].some((p) => route.toLowerCase().startsWith(p))
  if (typeof window !== "undefined" && !publicPage) {
    loadApp(signInPath(route))
  }
}

const REQUEST_TIMEOUT_MS = 10_000
export const TRANSFER_TIMEOUT_MS = 300_000

export async function request<T>(path: string, options: RequestInit & { responseType?: "blob"; timeoutMs?: number } = {}): Promise<T> {
  const baseUrl = getApiBaseUrl()
  const token = await getToken()

  const headers: Record<string, string> = {
    ...clientHeaders(),
    ...(options.headers as Record<string, string>),
  }

  // Only the desktop app has a token and sends it as a Bearer header, the web app uses the httpOnly cookie
  // A guest in a call proves themselves with their own pass or doc token, never with a member's session
  const asGuest = "Authorization" in headers || "X-Doc-Token" in headers
  if (token && !asGuest) {
    headers["Authorization"] = `Bearer ${token}`
  }

  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json"
  }

  const isUpload = options.body instanceof FormData
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? (isUpload ? TRANSFER_TIMEOUT_MS : REQUEST_TIMEOUT_MS))
  const abortFromCaller = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true })

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
      // Web sends the httpOnly auth cookie. Desktop (Tauri) omits credentials,
      // it authenticates with the Bearer token above, and the Tauri webview origin
      // cannot perform credentialed cross-origin requests against the API.
      credentials: isTauri() || asGuest ? "omit" : "include",
      signal: controller.signal,
    })

    if (res.status === 401) {
      // A guest's pass or doc token says nothing about a stored member session, so that session stays
      if (!asGuest) await handleUnauthorized()
      throw new ApiError(401, { error: "Unauthorized" })
    }

    if (!res.ok) {
      let data: Record<string, unknown>
      try {
        data = await res.json()
      } catch {
        data = { error: res.statusText }
      }
      noticeReadOnly(res.status, data)
      throw new ApiError(res.status, data, res.headers.get("Retry-After"))
    }

    if (options.responseType === "blob") {
      return (await res.blob()) as T
    }

    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T
    }

    return (await res.json()) as T
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", abortFromCaller)
  }
}

export function get<T>(path: string, opts?: { responseType?: "blob"; signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  return request<T>(path, { method: "GET", ...opts })
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  if (body instanceof FormData) {
    return request<T>(path, { method: "POST", body })
  }
  return request<T>(path, {
    method: "POST",
    body: body != null ? JSON.stringify(body) : undefined,
  })
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    body: body != null ? JSON.stringify(body) : undefined,
  })
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    body: body != null ? JSON.stringify(body) : undefined,
  })
}

export function del<T = void>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" })
}

export const queryOf = (params: Record<string, string | null | undefined>) => {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value)
  return query.toString()
}
