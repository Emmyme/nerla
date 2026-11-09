export const STATUS_OVERRIDES = ["available", "busy", "dnd", "away", "ooo", "offline", "secret"] as const
export type StatusOverride = (typeof STATUS_OVERRIDES)[number]
/** A chosen status, with `until` as an ISO instant or null */
export type Status = { value: StatusOverride; until: string | null }
type Live = { online: boolean; idle: boolean; inCall: boolean }

const OFFLINE: Live = { online: false, idle: false, inCall: false }

function isStatusOverride(value: unknown): value is StatusOverride {
  return typeof value === "string" && (STATUS_OVERRIDES as readonly string[]).includes(value)
}

/** The stored choice while it lasts, or null once it has ended, which counts as automatic */
export function activeStatus(value: string | null | undefined, until: Date | null | undefined, nowMs: number): Status | null {
  if (!isStatusOverride(value)) return null
  if (until && until.getTime() <= nowMs) return null
  return { value, until: until ? until.toISOString() : null }
}

/** A status read from the database applies only if no change landed while the read ran */
export function loadedStatusApplies(versionAtRead: number, versionNow: number): boolean {
  return versionAtRead === versionNow
}

/** The wait before reading a status again after a failed read: 0.5 s, doubling, at most 30 s */
export function statusRetryMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 30_000)
}

/** Whether a stored choice has ended and should be cleared */
export function statusExpired(value: string | null | undefined, until: Date | null | undefined, nowMs: number): boolean {
  return !!value && !!until && until.getTime() <= nowMs
}

/**
 * What a viewer sees. Others see a choice only while the user is connected, so signed out is offline, as in Teams.
 * Out of office shows signed out too, like one from the calendar. Appear offline looks just like signed out.
 * A secret shows only that it is one, with no live state and no end.
 */
export function presenceSeenBy(live: Live, status: Status | null, self: boolean): Live & { status: Status | null } {
  if (self) return { ...live, status }
  if (!live.online && status?.value === "ooo") return { ...OFFLINE, status }
  if (!live.online || status?.value === "offline") return { ...OFFLINE, status: null }
  if (status?.value === "secret") return { ...OFFLINE, status: { value: "secret", until: null } }
  return { ...live, status }
}

/** Whether a viewer may see the user's calendar availability. Only a secret, while it shows, hides it from others. */
export function availabilityShown(live: Live, status: Status | null, self: boolean): boolean {
  return presenceSeenBy(live, status, self).status?.value !== "secret" || self
}
