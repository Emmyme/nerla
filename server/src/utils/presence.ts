import { GUEST_IDENTITY_PREFIX } from "./docCalls"

type RoomParticipant = { identity: string; metadata?: string }

type Presence = { people: { userId: string; name: string }[]; guests: number }

function isGuest(participant: RoomParticipant): boolean {
  if (participant.identity.startsWith(GUEST_IDENTITY_PREFIX)) return true
  try {
    return participant.metadata ? (JSON.parse(participant.metadata) as { role?: unknown }).role === "guest" : false
  } catch {
    return false
  }
}

/**
 * Who a member sees from the pre-join: other members by id and name, and guests only as a count.
 * Names come from the users table, never from LiveKit, so an email never stands in for a name.
 */
export function roomPresence(participants: RoomParticipant[], selfId: string, names: Map<string, string>): Presence {
  const people: Presence["people"] = []
  let guests = 0
  for (const participant of participants) {
    if (isGuest(participant)) {
      guests++
      continue
    }
    const name = names.get(participant.identity)
    if (participant.identity === selfId || name === undefined || people.some((p) => p.userId === participant.identity)) continue
    people.push({ userId: participant.identity, name })
  }
  return { people, guests }
}

/** A member's name for others, or a neutral word when they have none */
export function presenceName(firstName: string | null, lastName: string | null): string {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || "Someone"
}
