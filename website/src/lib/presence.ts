import { availabilityText, formatUntil, type Availability } from "@/lib/availability"

export type PresenceState = "available" | "busy" | "dnd" | "away" | "ooo" | "offline" | "secret"
export type StatusOverride = "available" | "busy" | "dnd" | "away" | "ooo" | "offline" | "secret"
/** A status the user chose. `until` is an ISO instant, or null to keep it until changed. */
export type StatusChoice = { value: StatusOverride; until: string | null }
export type LivePresence = { online: boolean; idle: boolean; inCall: boolean }
/** Others never receive appear offline, and get a secret with no end, no live state and no calendar */
export type PresenceInfo = LivePresence & { availability: Availability; status?: StatusChoice | null }

export const PRESENCE_WORD: Record<PresenceState, string> = {
  available: "Available",
  busy: "Busy",
  dnd: "Do not disturb",
  away: "Away",
  ooo: "Out of office",
  offline: "Offline",
  secret: "That's a secret",
}

const BUSY_KINDS = new Set(["busy", "meeting", "focus"])

/** The calendar state, unless its instant has passed. A last day stays until the next refresh. */
function currentKind(availability: Availability | undefined, now: Date) {
  if (!availability?.kind) return null
  const { until } = availability
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until) && Date.parse(until) <= now.getTime()) return null
  return availability.kind
}

/** The chosen status while it lasts. One that has ended counts as automatic. */
export function activeStatus(status: StatusChoice | null | undefined, now: Date): StatusChoice | null {
  if (!status) return null
  if (status.until && Date.parse(status.until) <= now.getTime()) return null
  return status
}

/**
 * A choice shows only while connected, so signed out is offline, as in Teams. Out of office shows signed out too, like
 * one from the calendar. Others get a secret only while it shows.
 */
function shownStatus(info: PresenceInfo, now: Date): StatusChoice | null {
  const chosen = activeStatus(info.status, now)
  return chosen && (info.online || chosen.value === "secret" || chosen.value === "ooo") ? chosen : null
}

/** A chosen status while connected first, then out of office, offline, busy from a call or the calendar, away, and available */
export function presenceState(info: PresenceInfo, now: Date): PresenceState {
  const chosen = shownStatus(info, now)
  if (chosen) return chosen.value
  const kind = currentKind(info.availability, now)
  if (kind === "ooo") return "ooo"
  if (!info.online) return "offline"
  if (info.inCall || (kind && BUSY_KINDS.has(kind))) return "busy"
  return info.idle ? "away" : "available"
}

/** The tooltip, such as "Busy, in a meeting until 15:00", with outside working hours on a second line */
export function presenceText(info: PresenceInfo, now: Date, viewerZone: string): string {
  const state = presenceState(info, now)
  const calendar = availabilityText(info.availability, now, viewerZone)
  const chosen = shownStatus(info, now)
  if (chosen) {
    const until = chosen.until ? ` until ${formatUntil(new Date(chosen.until), now, viewerZone)}` : ""
    // Only the user who chose it ever receives appear offline
    if (chosen.value === "offline") return `Appear offline${until}`
    if (chosen.value === "secret") return PRESENCE_WORD.secret
    if (chosen.value === "busy" || chosen.value === "dnd" || chosen.value === "ooo") return `${PRESENCE_WORD[chosen.value]}${until}`
  }
  if (state === "ooo") return calendar ?? PRESENCE_WORD.ooo
  if (state === "busy") return info.inCall ? "Busy, in a call" : (calendar ?? PRESENCE_WORD.busy)
  const word = PRESENCE_WORD[state]
  return info.availability.kind === "off_hours" && calendar ? `${word}\n${calendar}` : word
}
