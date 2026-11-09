import { RoomServiceClient } from "livekit-server-sdk"
import { db, meetingParticipants } from "../db"
import { withTimeout } from "../utils/timedCheck"

/** The LiveKit address the server itself reaches, inside Docker that is the livekit service */
export const roomService = new RoomServiceClient(
  process.env.LIVEKIT_URL || "ws://localhost:7880",
  process.env.LIVEKIT_API_KEY || "",
  process.env.LIVEKIT_API_SECRET || "",
)

const LOOKUP_TIMEOUT_MS = 2500

/**
 * The rooms among `names` that LiveKit has participants in, from one lookup. A room that does not exist,
 * a failure or a slow answer all count as not live.
 */
export async function liveRoomNames(names: string[]): Promise<Set<string>> {
  const wanted = [...new Set(names)]
  if (wanted.length === 0) return new Set()
  try {
    const rooms = await withTimeout(roomService.listRooms(wanted), LOOKUP_TIMEOUT_MS)
    return new Set(rooms.filter((room) => room.numParticipants > 0).map((room) => room.name))
  } catch {
    return new Set()
  }
}

/** Whether LiveKit lists the user in the room. A failure counts as no. */
export async function inRoom(roomName: string, userId: string): Promise<boolean> {
  try {
    const participants = await withTimeout(roomService.listParticipants(roomName), LOOKUP_TIMEOUT_MS)
    return participants.some((participant) => participant.identity === userId)
  } catch {
    return false
  }
}

/** The identities LiveKit lists in the room. A failure lists nobody */
export async function participantIds(roomName: string): Promise<string[]> {
  try {
    return (await withTimeout(roomService.listParticipants(roomName), LOOKUP_TIMEOUT_MS)).map((participant) => participant.identity)
  } catch {
    return []
  }
}

/**
 * How many participants LiveKit lists in the room, 0 when the room is gone. Null when LiveKit fails or is slow, so a caller
 * never treats an outage as an empty room
 */
export async function participantCount(roomName: string): Promise<number | null> {
  try {
    return (await withTimeout(roomService.listParticipants(roomName), LOOKUP_TIMEOUT_MS)).length
  } catch (error) {
    return (error as { status?: number }).status === 404 ? 0 : null
  }
}

export async function addParticipant(organizationId: string, roomName: string, userId: string, invitedBy: string | null): Promise<void> {
  const insert = db.insert(meetingParticipants).values({ roomName, userId, invitedBy, organizationId })
  // A re-invite from inside the call marks an existing row as invited, so a removed guest can rejoin
  await (invitedBy
    ? insert.onConflictDoUpdate({
        target: [meetingParticipants.roomName, meetingParticipants.userId],
        set: { invitedBy },
      })
    : insert.onConflictDoNothing())
}

/**
 * Lets every member of a chat into its call room. Seeded rows carry no inviter, so only an invite from
 * inside the call ever counts as one. Rows that already exist keep their state.
 */
export async function seedParticipants(organizationId: string, roomName: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return
  await db
    .insert(meetingParticipants)
    .values(userIds.map((userId) => ({ roomName, userId, invitedBy: null, organizationId })))
    .onConflictDoNothing()
}
