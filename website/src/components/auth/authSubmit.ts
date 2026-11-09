import { isTauri } from "@tauri-apps/api/core"
import { clientHeaders } from "@/lib/api/request"
import { loadApp } from "@/lib/appPath"
import { getKnownMarks, setKnownMarks, setToken } from "@/lib/authToken"
import { getApiBaseUrl } from "@/lib/serverUrl"

const UNREACHABLE = "Couldn't reach the server. Check your connection and try again."
const TOO_MANY = "Too many attempts. Wait a minute and try again."
export const FAILED = "Something went wrong. Try again."

// Server messages that read better in the app's own words
const FRIENDLY: Record<string, string> = {
  "Invalid email or password": "That email and password don't match. Try again or reset your password.",
}

type Body = Record<string, unknown>

/** Posts to an auth endpoint directly, so a wrong password shows the server's message instead of the app's 401 redirect */
export async function authPost(endpoint: string, body: Body): Promise<Body> {
  let response: Response
  try {
    const known = isTauri() ? await getKnownMarks() : null
    response = await fetch(`${getApiBaseUrl()}/auth/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...clientHeaders(), ...(known ? { "X-Nerla-Known": known } : {}) },
      // Web needs credentials to keep the cookie the server sets, desktop uses the token in the body
      credentials: isTauri() ? "omit" : "include",
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error(UNREACHABLE)
  }
  const data: Body = await response.json().catch(() => ({}))
  if (response.status === 429) throw new Error(TOO_MANY)
  if (!response.ok) throw new Error(typeof data.error === "string" && data.error.trim() ? (FRIENDLY[data.error] ?? data.error) : FAILED)
  return data
}

/** Keeps the desktop token, then loads the app at the return path */
export async function enterApp(data: Body, next: string): Promise<true> {
  if (isTauri() && typeof data.token === "string") await setToken(data.token)
  if (isTauri() && typeof data.known === "string") await setKnownMarks(data.known)
  loadApp(next)
  return true
}
