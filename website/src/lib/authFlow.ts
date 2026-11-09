export type LinkedFlow = { mode: "activate" | "reset"; email?: string; token?: string }

/** Invite and reset links carry their query in the search, or inside the hash on the desktop build */
export function parseLinkedFlow(search: string, hash: string): LinkedFlow | null {
  const sources = [search, hash.includes("?") ? hash.slice(hash.indexOf("?")) : ""]
  for (const source of sources) {
    const params = new URLSearchParams(source)
    const mode = params.get("mode")
    if (mode !== "activate" && mode !== "reset") continue
    const flow: LinkedFlow = { mode }
    const email = params.get("email")
    const token = params.get("token")
    if (email) flow.email = email
    if (token) flow.token = token
    return flow
  }
  return null
}

/** The same address without the link's token, in the search or inside the hash */
export function withoutToken(href: string): string {
  const url = new URL(href)
  url.searchParams.delete("token")
  const query = url.hash.indexOf("?")
  if (query >= 0) {
    const params = new URLSearchParams(url.hash.slice(query + 1))
    params.delete("token")
    const rest = params.toString()
    url.hash = url.hash.slice(0, query) + (rest ? `?${rest}` : "")
  }
  return url.toString()
}

type PasswordRule = { id: "length" | "lower" | "upper" | "digit" | "special"; label: string; met: boolean }

/** The same checks as the server's strongPassword */
export function passwordRules(pw: string): PasswordRule[] {
  return [
    { id: "length", label: "8 to 128 characters", met: pw.length >= 8 && pw.length <= 128 },
    { id: "lower", label: "A lowercase letter", met: /[a-z]/.test(pw) },
    { id: "upper", label: "An uppercase letter", met: /[A-Z]/.test(pw) },
    { id: "digit", label: "A number", met: /[0-9]/.test(pw) },
    { id: "special", label: "A special character", met: /[^a-zA-Z0-9]/.test(pw) },
  ]
}

export function passwordValid(pw: string): boolean {
  return passwordRules(pw).every((rule) => rule.met)
}

/** What a submit with an unfinished password says, such as "Your password still needs a number and a special character." */
export function missingRulesMessage(pw: string): string | null {
  const missing = passwordRules(pw)
    .filter((rule) => !rule.met)
    .map((rule) => rule.label.charAt(0).toLowerCase() + rule.label.slice(1))
  if (missing.length === 0) return null
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`
  return `Your password still needs ${list}.`
}

export const BUSY_MESSAGE = "The server is busy. Trying again in a moment."

const BUSY_DEFAULT_MS = 10_000
const BUSY_MAX_MS = 300_000

/** A 429 means the server is up but busy. Returns how long to wait before asking again, or null for any other status. */
export function busyRetryMs(status: number, retryAfter: string | null, now = Date.now()): number | null {
  if (status !== 429) return null
  const value = retryAfter?.trim()
  if (!value) return BUSY_DEFAULT_MS
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  if (!Number.isFinite(ms)) return BUSY_DEFAULT_MS
  return Math.min(Math.max(ms, 1000), BUSY_MAX_MS)
}

export type ProbeResult =
  { ok: true; needsSetup: boolean } | { ok: false; busy: true; retryMs: number } | { ok: false; busy?: false; reason: string }

/** What the setup-status probe means for the sign-in screen */
export function probeOutcome(status: number, retryAfter: string | null, data: unknown): ProbeResult {
  const retryMs = busyRetryMs(status, retryAfter)
  if (retryMs !== null) return { ok: false, busy: true, retryMs }
  if (status < 200 || status >= 300) return { ok: false, reason: `Server returned HTTP ${status}` }
  const needsSetup = (data as { needsSetup?: unknown } | null)?.needsSetup
  if (typeof needsSetup !== "boolean") return { ok: false, reason: "Server does not appear to be a Nerla instance" }
  return { ok: true, needsSetup }
}
