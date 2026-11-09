import { STRICTNESS_LEVELS, type Strictness } from "./aiTypes"
import { serverInstant } from "./chatAccess"

/** How long a card waits for the asker */
export const HOLD_MS = 10 * 60 * 1000

/** A stored level the code doesn't know counts as the strictest */
const rank = (level: Strictness) => Math.max(0, STRICTNESS_LEVELS.indexOf(level))

/** The stricter of the workspace's level and the user's own wins */
export function effectiveStrictness(workspace: Strictness, personal: Strictness | null): Strictness {
  return STRICTNESS_LEVELS[Math.min(rank(workspace), personal ? rank(personal) : rank(workspace))]
}

/** Anything written by another user, or by an unknown author, taints the request */
export const isTainting = (authors: (string | null)[], askerId: string): boolean => authors.some((author) => author !== askerId)

/** Whether a call waits for the asker's Allow */
export function needsAllow(input: {
  write: boolean
  alwaysGated: boolean
  strictness: Strictness
  tainted: boolean
  othersCanSee: boolean
}): boolean {
  if (input.alwaysGated) return true
  if (!input.write) return false
  switch (input.strictness) {
    case "sensitive":
      return false
    case "tainted":
      return input.tainted && input.othersCanSee
    default:
      return true
  }
}

/** The tools that move one thing to Trash or bring one back. Each is always gated */
export const TRASH_TOOLS = ["delete_task", "cancel_event", "delete_doc", "delete_file", "restore_from_trash"]

/** How many trash changes one request can hold in all */
export const TRASH_PER_REQUEST = 10

export const ONE_AT_A_TIME = "Delete or restore one thing at a time"
export const TOO_MUCH_TRASH = "That's a lot of deleting. Ask the user to do the rest from the trash"

/** The calls of one turn to refuse: every trash change after the first, so one card never holds two */
export function trashRefusals(calls: string[]): number[] {
  const first = calls.findIndex((name) => TRASH_TOOLS.includes(name))
  return calls.flatMap((name, index) => (index > first && first !== -1 && TRASH_TOOLS.includes(name) ? [index] : []))
}

/** `members` is the group chat's members when the card was made, so a change shares with exactly them */
export type HeldItem = { id: string; tool: string; args: unknown; summary: string; members?: string[] }

export type TakeError = "gone" | "timed-out" | "not-on-card"

/** The items one Allow runs: exactly the chosen ones on the card, each once, in the card's order */
export function takeBatch(
  held: { status: string; items: HeldItem[]; expiresAt: string | Date },
  chosen: string[],
  now: Date,
): { run: HeldItem[] } | { error: TakeError } {
  if (held.status === "expired") return { error: "timed-out" }
  if (held.status !== "waiting") return { error: "gone" }
  const expires = held.expiresAt instanceof Date ? held.expiresAt.getTime() : serverInstant(held.expiresAt)
  if (!(expires > now.getTime())) return { error: "timed-out" }
  const onCard = new Set(held.items.map((item) => item.id))
  if (chosen.some((id) => !onCard.has(id))) return { error: "not-on-card" }
  const picked = new Set(chosen)
  return { run: held.items.filter((item) => picked.has(item.id)) }
}
