/** A UserAvatar user from a display name, with its first word as the first name and its last word as the last name */
export function avatarOf(id: string, name: string) {
  const [first = "", ...rest] = name.trim().split(/\s+/)
  return { id, first_name: first, last_name: rest.at(-1) ?? "" }
}

/** A guest has no account, so the name stands in for the id */
export const guestAvatar = (name: string) => avatarOf(name.trim() || "guest", name)
