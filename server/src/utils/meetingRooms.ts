import { randomUUID } from "node:crypto"
import { UUID_TEXT as UUID } from "./uuid"

/** Rooms opened since workspaces were isolated start with `o{first 8 hex of the org id}-`. Older names have no prefix. */
const ORG_PREFIX = "(?:o([0-9a-f]{8})-)?"
const DM_ROOM = new RegExp(`^${ORG_PREFIX}dm-(${UUID})-(${UUID})$`, "i")
const SCHEDULED_ROOM = new RegExp(`^meeting-(${UUID})$`, "i")
const INSTANT_ROOM = new RegExp(`^${ORG_PREFIX}${UUID}$`, "i")

type RoomKind =
  | { kind: "scheduled"; eventId: string }
  | { kind: "dm"; org: string | null; a: string; b: string }
  | { kind: "instant"; org: string | null }
  | { kind: "invalid" }

export function roomKind(roomName: string): RoomKind {
  const scheduled = roomName.match(SCHEDULED_ROOM)
  if (scheduled) return { kind: "scheduled", eventId: scheduled[1].toLowerCase() }
  const dm = roomName.match(DM_ROOM)
  if (dm) return { kind: "dm", org: dm[1]?.toLowerCase() ?? null, a: dm[2], b: dm[3] }
  const instant = roomName.match(INSTANT_ROOM)
  if (instant) return { kind: "instant", org: instant[1]?.toLowerCase() ?? null }
  return { kind: "invalid" }
}

export function roomPrefix(organizationId: string): string {
  return `o${organizationId.slice(0, 8).toLowerCase()}-`
}

/** A meet now or group call room, named after its workspace */
export function instantRoom(organizationId: string): string {
  return `${roomPrefix(organizationId)}${randomUUID()}`
}

/** The name carries another workspace's prefix. Older names carry none and are decided by their rows. */
export function foreignRoom(roomName: string, organizationId: string): boolean {
  const room = roomKind(roomName)
  return (room.kind === "dm" || room.kind === "instant") && room.org !== null && `o${room.org}-` !== roomPrefix(organizationId)
}

/** Scheduled and workspace rooms are stored and joined in lowercase, however the client spelled them. */
export function canonicalRoom(roomName: unknown): string {
  if (typeof roomName !== "string") return roomName as string
  const room = roomKind(roomName)
  const lower = room.kind === "scheduled" || ((room.kind === "dm" || room.kind === "instant") && room.org !== null)
  return lower ? roomName.toLowerCase() : roomName
}
