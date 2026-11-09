type ProjectMemberRow = { userId: string; role: string; createdAt: string }

/** The member to promote so the project keeps an admin, or null when none is needed or nobody is left. */
export function nextProjectAdmin(members: ProjectMemberRow[], leavingUserId: string): string | null {
  const remaining = members.filter((m) => m.userId !== leavingUserId)
  if (remaining.length === 0 || remaining.some((m) => m.role === "admin")) return null
  const [longest] = [...remaining].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.userId.localeCompare(b.userId))
  return longest.userId
}

/** True when giving `userId` a non-admin role would leave the project with no admin. */
export function removesLastAdmin(members: { userId: string; role: string }[], userId: string, role: string): boolean {
  if (role === "admin") return false
  const isAdmin = members.some((m) => m.userId === userId && m.role === "admin")
  return isAdmin && !members.some((m) => m.userId !== userId && m.role === "admin")
}
