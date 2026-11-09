import { roomKind } from "./meetingRooms"

export type RoomRow = { userId: string; invitedBy: string | null }

type RoomFacts = {
  /** The room's participant rows in the caller's workspace */
  rows: RoomRow[]
  /** Whether a row of another workspace holds the room, judged from every row of it */
  taken: boolean
  /** Whether a user belongs to the caller's workspace */
  inOrg: (userId: string) => boolean
}

/** `missing` asks the route to answer like for a room that does not exist */
type RoomAccess = { allowed: boolean; seed: string[]; missing?: true }

const DENIED: RoomAccess = { allowed: false, seed: [] }
const MISSING: RoomAccess = { allowed: false, seed: [], missing: true }

export function dmPartner(userId: string, room: { a: string; b: string }): string | null {
  return userId === room.a ? room.b : userId === room.b ? room.a : null
}

/**
 * Who may enter a 1:1 or instant room, and the participant rows entering adds. A 1:1 room is for its two
 * users in one workspace, plus a user that a workspace member already in the call invited. An instant room
 * belongs to whoever opened it first, and only a name with the workspace prefix can be opened that way. An old style
 * name without the prefix keeps working only while it has rows. A room another workspace holds looks missing.
 * Scheduled rooms follow their event and are never decided here.
 */
export function directRoomAccess(userId: string, roomName: string, facts: RoomFacts): RoomAccess {
  const room = roomKind(roomName)
  if (room.kind === "scheduled") return DENIED
  if (facts.taken) return MISSING

  if (room.kind === "dm") {
    const other = dmPartner(userId, room)
    if (other) return facts.inOrg(other) ? { allowed: true, seed: [room.a, room.b] } : DENIED
    if (!facts.inOrg(room.a) || !facts.inOrg(room.b)) return DENIED
    const inviter = facts.rows.find((row) => row.userId === userId)?.invitedBy
    const invited = !!inviter && facts.rows.some((row) => row.userId === inviter) && facts.inOrg(inviter)
    return invited ? { allowed: true, seed: [] } : DENIED
  }

  if (room.kind !== "instant") return DENIED
  if (facts.rows.some((row) => row.userId === userId)) return { allowed: true, seed: [] }
  if (facts.rows.length > 0) return DENIED
  return room.org === null ? MISSING : { allowed: true, seed: [userId] }
}
