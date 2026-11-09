export type Presence = { people: { userId: string; name: string }[]; guests: number }

/** The pre-join line about who is already in the call */
export function presenceLine(presence: Presence): string {
  const names = presence.people.map((p) => p.name)
  const total = names.length + presence.guests
  if (total === 0) return "No one else is here yet"
  if (names.length === 0) return total === 1 ? "A guest is in the call" : `${total} guests are in the call`
  if (total === 1) return `${names[0]} is in the call`
  if (total === 2 && names.length === 2) return `${names[0]} and ${names[1]} are in the call`
  const rest = total - 1
  return `${names[0]} and ${rest} ${rest === 1 ? "other" : "others"} are in the call`
}
