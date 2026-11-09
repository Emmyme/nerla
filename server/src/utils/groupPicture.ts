type Membership = { role: string; chat: { projectId: string | null } } | null

/** Why the user may not change a group's symbol or picture, or null when they may: only its admins, and never a project chat */
export function styleRefusal(membership: Membership): { status: 403 | 409; error: string } | null {
  if (!membership) return { status: 403, error: "Not a member of this group chat" }
  if (membership.role !== "admin") return { status: 403, error: "Only group admins can change the symbol or picture" }
  if (membership.chat.projectId) return { status: 409, error: "A project chat shows its project's symbol" }
  return null
}

/** A group's picture goes only to a member of the group, and only the file that is its picture now */
export function mayServePicture(membership: Membership, current: string | null | undefined, fileId: string): boolean {
  return !!membership && !!current && current === fileId
}
