import { instantRoom, roomPrefix } from "./meetingRooms"
import { renderMentions, type MentionNames } from "./mentions"

type ChatThread = { kind: "dm"; a: string; b: string } | { kind: "group"; memberIds: string[] }

/** A chat as the server addresses it: a DM by both users, a group by its id and members */
export type ChatRef = { kind: "dm"; a: string; b: string } | { kind: "group"; id: string; memberIds: string[] }

const PREVIEW_LENGTH = 120

export const FILE_PLACEHOLDER = "(file attachment)"

/** A call counts as live this long after it is posted, while the caller is still on the pre-join */
export const CALL_GRACE_MS = 2 * 60 * 1000

/** Server timestamps carry no zone and are UTC */
export function serverInstant(value: string): number {
  const iso = value.includes("T") ? value : value.replace(" ", "T")
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)
}

export function isUnread(lastMessageFromOthersAt: string | null, lastReadAt: string | null): boolean {
  if (!lastMessageFromOthersAt) return false
  if (!lastReadAt) return true
  const message = serverInstant(lastMessageFromOthersAt)
  const read = serverInstant(lastReadAt)
  if (Number.isNaN(message) || Number.isNaN(read)) return lastMessageFromOthersAt > lastReadAt
  return message > read
}

/** Everyone who hears about a chat event, the sender included, so their other devices update too */
export function chatAudience(thread: ChatThread): string[] {
  return thread.kind === "dm" ? [...new Set([thread.a, thread.b])] : [...new Set(thread.memberIds)]
}

/** How the user refers to a chat: a DM by the other user's id, a group by its own id */
export function chatIdFor(thread: { kind: "dm"; a: string; b: string } | { kind: "group"; id: string }, userId: string): string {
  if (thread.kind === "group") return thread.id
  return userId === thread.a ? thread.b : thread.a
}

export function threadOf(chat: ChatRef): ChatThread {
  return chat.kind === "dm" ? chat : { kind: "group", memberIds: chat.memberIds }
}

function sortedPair(a: string, b: string): string {
  const [first, second] = [a.toLowerCase(), b.toLowerCase()].sort()
  return `dm-${first}-${second}`
}

export function dmRoom(organizationId: string, a: string, b: string): string {
  return `${roomPrefix(organizationId)}${sortedPair(a, b)}`
}

/**
 * A DM always calls in its own room, and a call still live under the name it had before workspace
 * prefixes is rejoined. A group joins a call that is still live, otherwise it opens a new room.
 */
export function chatCallPlan(organizationId: string, thread: ChatThread, liveRoom: string | null): { roomName: string; post: boolean } {
  if (thread.kind === "dm") {
    const roomName = dmRoom(organizationId, thread.a, thread.b)
    if (liveRoom === roomName || liveRoom === sortedPair(thread.a, thread.b)) return { roomName: liveRoom, post: false }
    return { roomName, post: true }
  }
  return liveRoom ? { roomName: liveRoom, post: false } : { roomName: instantRoom(organizationId), post: true }
}

/** Oldest first. Who becomes admin when none is left: the preferred user when present, else the oldest member. */
export function nextAdmin(members: { id: string; userId: string; role: string }[], preferredUserId?: string | null): string | null {
  if (members.length === 0 || members.some((m) => m.role === "admin")) return null
  return (members.find((m) => m.userId === preferredUserId) ?? members[0]).id
}

/**
 * Mentions read as their names, so a token is never cut short. `keepLines` keeps the line breaks of markdown the AI
 * said, so the website can take its list and heading marks off
 */
export function messagePreview(kind: string, content: string, names: MentionNames = new Map(), keepLines = false): string {
  if (kind === "call") return "Call started"
  if (content === FILE_PLACEHOLDER) return "Sent an attachment"
  const text = renderMentions(content, names)
    .replace(keepLines ? /[^\S\n]+/g : /\s+/g, " ")
    .trim()
  return Array.from(text).slice(0, PREVIEW_LENGTH).join("")
}
