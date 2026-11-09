export type InviteOutcome =
  | { kind: "link"; email: string; url: string; expiresAt: string; emailing: boolean }
  | { kind: "rejoin"; email: string; expiresAt: string; emailing: boolean }
  | { kind: "error"; email: string }

/** What an invite produced. A new account comes back with a link to pass on, a removed account invited back with none. */
export function inviteOutcome(
  res: { inviteUrl?: string | null; inviteExpiresAt?: string | null; email?: "sending" | "not-set-up"; rejoin?: boolean },
  email: string,
): InviteOutcome {
  if (res.rejoin === true) {
    const expiresAt = typeof res.inviteExpiresAt === "string" ? res.inviteExpiresAt : ""
    return { kind: "rejoin", email, expiresAt, emailing: res.email === "sending" }
  }
  const url = typeof res.inviteUrl === "string" ? res.inviteUrl.trim() : ""
  const expiresAt = typeof res.inviteExpiresAt === "string" ? res.inviteExpiresAt : ""
  if (!url || !expiresAt) return { kind: "error", email }
  return { kind: "link", email, url, expiresAt, emailing: res.email === "sending" }
}
