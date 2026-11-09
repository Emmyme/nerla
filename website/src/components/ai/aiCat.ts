/** How long the cat stays awake after the last thing it was waiting on ends */
export const WAKE_MS = 4000

type CatInput = { windowOpen: boolean; running: boolean; waiting: boolean; endedAt: number | null; now: number }

export function catState({ windowOpen, running, waiting, endedAt, now }: CatInput): "awake" | "asleep" {
  if (windowOpen || running || waiting) return "awake"
  return endedAt !== null && now - endedAt < WAKE_MS ? "awake" : "asleep"
}
