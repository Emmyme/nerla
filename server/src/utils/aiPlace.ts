import type { ItemRef } from "./aiTypes"

/** The DM between two users as one ref, whichever of them asks */
export const dmRef = (a: string, b: string): ItemRef => ({ kind: "chat", id: `dm:${[a, b].sort().join(":")}` })

/** The two users of a DM ref, or null for a group chat */
export function dmPeople(ref: ItemRef): [string, string] | null {
  if (ref.kind !== "chat" || !ref.id.startsWith("dm:")) return null
  const [a, b] = ref.id.slice(3).split(":")
  return a && b ? [a, b] : null
}

/** How many `canRead` checks run at once */
const IN_FLIGHT = 8

/**
 * The shared-place rule: an item is kept only when every member of the place can read it. A place with
 * nobody in it keeps nothing, and a check that fails fails the whole call
 */
export async function filterShared<T extends { ref: ItemRef }>(
  items: T[],
  audience: string[],
  canRead: (userId: string, ref: ItemRef) => Promise<boolean>,
): Promise<T[]> {
  if (audience.length === 0) return []
  const kept = items.map(() => true)
  const checks = items.flatMap((_item, i) => audience.map((userId) => ({ i, userId })))
  let next = 0
  const worker = async () => {
    while (next < checks.length) {
      const { i, userId } = checks[next++]
      // One member who can't read it is enough, so the rest of its checks are skipped
      if (kept[i] && !(await canRead(userId, items[i].ref))) kept[i] = false
    }
  }
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, checks.length) }, worker))
  return items.filter((_item, i) => kept[i])
}
