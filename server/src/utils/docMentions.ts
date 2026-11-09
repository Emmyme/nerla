/**
 * Which users a store records as mentioned: those not recorded yet who can open the doc now. `settled` needs no
 * look again while the doc stays loaded. A user who can't open it yet is asked again at the next store, so a mention
 * is never used up before its user gets access
 */
export function mentionsToRecord(
  mentioned: string[],
  recorded: ReadonlySet<string>,
  canOpen: ReadonlySet<string>,
): { record: string[]; settled: string[] } {
  const record = mentioned.filter((id) => !recorded.has(id) && canOpen.has(id))
  const settled = mentioned.filter((id) => recorded.has(id) || canOpen.has(id))
  return { record, settled }
}

/** Mentioned users who could not open the doc yet are looked at again at most this often */
const MENTION_RECHECK_MS = 60_000

/** What a loaded doc remembers of its mentions: who is settled, who waits for access, and when they were last looked at */
type MentionState = { known: ReadonlySet<string>; waiting: ReadonlySet<string>; checkedAt: number }

/**
 * Which mentioned users a store looks at. A store with no member behind it, such as a guest's change, looks at
 * nobody, so the next store a member makes records and tells them. Users still waiting for access are looked at
 * again only once the doc's last look is a minute old
 */
export function mentionsToCheck(mentioned: string[], state: MentionState, actorId: string | null, now: number): string[] {
  if (!actorId) return []
  const due = now - state.checkedAt >= MENTION_RECHECK_MS
  return mentioned.filter((id) => !state.known.has(id) && (due || !state.waiting.has(id)))
}
