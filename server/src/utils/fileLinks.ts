import { randomBytes } from "crypto"
import { serverInstant } from "./chatAccess"
import { DAY_MS } from "./eventTime"
import { REMOVAL_DAYS } from "./fileAccess"
import { TRASH_DAYS } from "./trash"

export { TRASH_DAYS }

type LinkExpiry = "1d" | "7d" | "30d" | "never"
export const LINK_EXPIRIES = ["1d", "7d", "30d", "never"] as const satisfies readonly LinkExpiry[]
type LinkState = "active" | "expired" | "revoked" | "gone"

const EXPIRY_DAYS: Record<Exclude<LinkExpiry, "never">, number> = { "1d": 1, "7d": 7, "30d": 30 }
export const DRAFT_DAYS = 1
export const AVATAR_DAYS = 1
/** Turned off and expired links are kept this long, then deleted */
export const LINK_KEEP_DAYS = 30

export function expiryDate(choice: LinkExpiry, now: Date): string | null {
  return choice === "never" ? null : new Date(now.getTime() + EXPIRY_DAYS[choice] * DAY_MS).toISOString()
}

/**
 * The file is null when it no longer exists. `ownerRemovedAt` is when the user the link rests on left the
 * workspace: the owner of a personal item, or the link's creator for a project item
 */
export function linkState(
  link: { expiresAt: string | null; revokedAt: string | null },
  file: { deletedAt: string | null; ownerRemovedAt: string | null } | null,
  now: Date,
): LinkState {
  if (link.revokedAt) return "revoked"
  if (link.expiresAt && now.getTime() >= serverInstant(link.expiresAt)) return "expired"
  if (!file || file.deletedAt || file.ownerRemovedAt) return "gone"
  return "active"
}

export function newLinkToken(): string {
  return randomBytes(32).toString("base64url")
}

const olderThan = (value: string | null, days: number, now: Date) => !!value && now.getTime() - serverInstant(value) >= days * DAY_MS

export function shouldPurge(
  row: {
    deletedAt: string | null
    isDraft: boolean
    createdAt: string
    projectId: string | null
    ownerRemovedAt: string | null
    ownerRejoinUntil: string | null
  },
  now: Date,
): boolean {
  if (olderThan(row.deletedAt, TRASH_DAYS, now)) return true
  if (row.isDraft && olderThan(row.createdAt, DRAFT_DAYS, now)) return true
  if (row.projectId || !olderThan(row.ownerRemovedAt, REMOVAL_DAYS, now)) return false
  return !row.ownerRejoinUntil || serverInstant(row.ownerRejoinUntil) <= now.getTime()
}

/** An avatar that is nobody's current one and posted nowhere, a day after upload */
export function isStaleAvatar(row: { createdAt: string; referenced: boolean }, now: Date): boolean {
  return !row.referenced && olderThan(row.createdAt, AVATAR_DAYS, now)
}
