import { hasJoinLink, sameRoom, type CallChat } from "@/lib/meetingWindow"

/** The sonner toaster that lives on the call stage, next to the connection notices */
export const CALL_TOASTER = "call"

export const CALL_TOAST_SURFACE =
  "pointer-events-auto flex w-full items-center gap-3 rounded-lg border border-app-border bg-app-surface p-3 text-app-text shadow-[var(--shadow-popover)]"

export type Invite = { roomName: string; callerId: string; callerName: string; title: string; at: number; chat?: CallChat | null }

export const INVITE_TTL = 45_000
const MAX_CARDS = 3

/** Cards newest first, one per room, at most three, none older than 45 seconds */
export function queueInvite(queue: Invite[], invite: Invite, now: number): Invite[] {
  const kept = queue.filter((i) => !sameRoom(i.roomName, invite.roomName) && now - i.at < INVITE_TTL)
  return [invite, ...kept].slice(0, MAX_CARDS)
}

export const isDmRoom = (roomName: string) => !hasJoinLink(roomName)

/** The server falls back to "Meeting" for rooms without a title */
export function inviteLine(invite: Pick<Invite, "roomName" | "callerName" | "title">): string {
  if (isDmRoom(invite.roomName)) return `${invite.callerName} is calling`
  const title = invite.title.trim()
  return `${invite.callerName} invited you to ${!title || title === "Meeting" ? "a meeting" : title}`
}
