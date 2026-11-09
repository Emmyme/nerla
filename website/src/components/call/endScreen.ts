import { DisconnectReason } from "livekit-client"

export type EndCopy = { title: string; body: string; rejoin: boolean; close: boolean }

export const CONNECTION_LOST = "Connection lost"

/**
 * What the screen after a call says. A member who leaves on purpose from a desktop meeting window or a
 * popup has nothing to come back to there, so that window closes instead. The caller knows the window
 * (isMeetingWindow).
 */
export function endScreen(reason: DisconnectReason | undefined, left: boolean, guest: boolean, inWindow = false): EndCopy {
  if (left || reason === DisconnectReason.CLIENT_INITIATED) {
    if (!guest && inWindow) return { title: "You left the meeting", body: "", rejoin: false, close: true }
    return { title: "You left the meeting", body: "You can rejoin while the meeting is still going.", rejoin: true, close: false }
  }
  switch (reason) {
    case DisconnectReason.DUPLICATE_IDENTITY:
      return { title: "You joined from another window", body: "The call goes on in your other window.", rejoin: false, close: false }
    case DisconnectReason.ROOM_DELETED:
      return { title: "The meeting ended", body: "The meeting was ended for everyone.", rejoin: false, close: false }
    case DisconnectReason.PARTICIPANT_REMOVED:
      return { title: "You were removed from the meeting", body: "Someone in the meeting removed you.", rejoin: false, close: false }
    default:
      return { title: CONNECTION_LOST, body: "Check your internet and rejoin.", rejoin: true, close: false }
  }
}
