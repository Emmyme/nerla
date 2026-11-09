export type GuestOutcome = "waiting" | "admitted" | "denied" | "expired" | "missing" | "busy"

export const GUEST_POLL_MS = 2500
export const GUEST_BUSY_PAUSE_MS = 15000

// A 404 means the session is gone while polling, but the meeting itself when asking
export function guestOutcome(
  httpStatus: number,
  body?: { status?: string; token?: string },
  phase: "request" | "status" = "status",
): GuestOutcome {
  if (httpStatus === 429) return "busy"
  if (httpStatus === 404) return phase === "request" ? "missing" : "expired"
  if (httpStatus >= 200 && httpStatus < 300) {
    // The token is handed out once, so a later read that finds none means asking again
    if (body?.status === "admitted") return body.token ? "admitted" : "expired"
    if (body?.status === "denied") return "denied"
    // A tab closed while waiting cancels the request, and a page restored from the back cache finds it so
    if (body?.status === "cancelled") return "expired"
  }
  return "waiting"
}
