import { createHmac, randomBytes } from "node:crypto"

export const SHARE_LEVELS = ["details", "busy", "private"] as const
export const GRANT_LEVELS = ["busy", "everything"] as const
export const DEFAULT_SHARE_LEVEL: ShareLevel = "details"

export type ShareLevel = (typeof SHARE_LEVELS)[number]
export type GrantLevel = (typeof GRANT_LEVELS)[number]
export type Visibility = "full" | "busy" | "hidden"

/** One user's sharing toward the viewer: their workspace default and any grant to the viewer. */
export type SharingTowardViewer = { default_level: ShareLevel; grantToViewer: GrantLevel | null }

export type VisibilityContext = {
  isCreator: boolean
  isAttendee: boolean
  /** The user whose calendar the row is shown on. */
  ownerSharing: SharingTowardViewer
  /** The event's creator. The same as `ownerSharing` for an event on its creator's own calendar. */
  creatorSharing: SharingTowardViewer
  mode: "mine" | "team"
}

const BUSY_UNDER_DETAILS = new Set(["personal", "focus"])
const RANK: Record<Visibility, number> = { hidden: 0, busy: 1, full: 2 }

function teamLevel(sharing: SharingTowardViewer, eventType: string): Visibility {
  if (sharing.grantToViewer === "everything") return "full"
  if (sharing.default_level === "details") return BUSY_UNDER_DETAILS.has(eventType) ? "busy" : "full"
  if (sharing.default_level === "busy") return "busy"
  return sharing.grantToViewer === "busy" ? "busy" : "hidden"
}

/** Whether any teammate sees an event of this type in full in team view, from its creator's sharing */
export function teammatesSeeDetails(sharing: { default_level: string; grants: { level: string }[] }, eventType: string): boolean {
  if (sharing.grants.some((grant) => grant.level === "everything")) return true
  return teamLevel({ default_level: sharing.default_level as ShareLevel, grantToViewer: null }, eventType) === "full"
}

/**
 * Spec 4.4 and 4.8. Creators, guests and Everyone events always see everything. My calendar shows
 * nothing else. Team view takes the stricter of the calendar owner's and the creator's sharing,
 * so an event never shows more on a teammate's calendar than its creator allows. An unknown
 * level counts as private.
 */
export function visibilityFor(
  event: { createdBy: string; eventType: string; everyone: boolean },
  viewer: { id: string },
  ctx: VisibilityContext,
): Visibility {
  if (ctx.isCreator || event.createdBy === viewer.id || ctx.isAttendee || event.everyone) return "full"
  if (ctx.mode !== "team") return "hidden"
  const owner = teamLevel(ctx.ownerSharing, event.eventType)
  const creator = teamLevel(ctx.creatorSharing, event.eventType)
  return RANK[owner] <= RANK[creator] ? owner : creator
}

/** Out of office exists to tell teammates, so they always see it with its dates, at least as a block. */
export function teamFloor(eventType: string, visibility: Visibility): Visibility {
  return eventType === "ooo" && visibility === "hidden" ? "busy" : visibility
}

type EventAccess = "allowed" | "forbidden" | "not-found"

/**
 * Who may change an event. The creator always may. An admin may delete any event in the org, for
 * moderation, but edit only one they see in full. Any other user gets "forbidden" for an event they
 * can see and "not-found" otherwise, and so does an admin editing one they cannot see in full.
 */
export function eventAccess(
  action: "edit" | "delete",
  event: { createdBy: string },
  viewer: { id: string; role: string },
  visibility: Visibility,
): EventAccess {
  if (event.createdBy === viewer.id) return "allowed"
  if (viewer.role === "admin") {
    if (action === "delete" || visibility === "full") return "allowed"
    return "not-found"
  }
  return visibility === "hidden" ? "not-found" : "forbidden"
}

/**
 * A busy block carries no creator. `calendar_user_id` places it on the calendar it is shown on,
 * so a block on a teammate's calendar never reveals who made the event. Its id is opaque and differs
 * per calendar and occurrence, so two users' blocks never show they share an event.
 */
export type BusyDto = {
  id: string
  starts_at: string | null
  ends_at: string | null
  all_day: boolean
  calendar_user_id: string
  busy: true
  /** Out of office keeps its label when the rest is hidden */
  ooo?: true
}

// Keyed, so a client that knows an event id cannot recompute which busy block it is
let busyKey: Buffer | null = null
function busyIdKey(): Buffer {
  busyKey ??= process.env.JWT_SECRET ? createHmac("sha256", process.env.JWT_SECRET).update("nerla-busy-id").digest() : randomBytes(32)
  return busyKey
}

function busyId(eventId: string, calendarUserId: string, startsAt: string | null): string {
  return `busy-${createHmac("sha256", busyIdKey())
    .update([eventId, calendarUserId, startsAt ?? ""].join("|"))
    .digest("hex")
    .slice(0, 20)}`
}

export function redact(dto: Omit<BusyDto, "busy" | "ooo"> & { event_type?: string }): BusyDto {
  return {
    id: busyId(dto.id, dto.calendar_user_id, dto.starts_at),
    starts_at: dto.starts_at,
    ends_at: dto.ends_at,
    all_day: dto.all_day,
    calendar_user_id: dto.calendar_user_id,
    busy: true,
    ...(dto.event_type === "ooo" ? { ooo: true as const } : {}),
  }
}
