import { useEffect, useSyncExternalStore } from "react"
import { aiAPI, type PersonalAi } from "@/lib/api/ai"
import { reloadAiTeammate } from "@/lib/aiStore"

/** `failed` means the last load didn't answer, so whether the AI is on is unknown rather than no */
type AiAccess = { me: PersonalAi | null; loaded: boolean; failed: boolean }

let state: AiAccess = { me: null, loaded: false, failed: false }
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function commit(next: AiAccess) {
  // Whether the AI teammate is there may have changed with these settings
  if (next.me && state.me && next.me !== state.me) reloadAiTeammate()
  state = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Asks the server again, after the workspace switches or the user's own settings change */
export function reloadAiAccess(): Promise<void> {
  loading = aiAPI.me().then(
    (me) => commit({ me, loaded: true, failed: false }),
    () => {
      // The next view that needs it asks again
      loading = null
      commit({ me: state.me, loaded: true, failed: true })
    },
  )
  return loading
}

/** Shown while the workspace has the AI teammate or MCP access on */
export const aiVisibleOf = (me: PersonalAi | null): boolean => !!me && (me.available || me.mcpEnabled)

/** The user's AI settings as the workspace allows them, loaded once and only when `enabled` */
export function useAiAccess(enabled = true): AiAccess {
  useEffect(() => {
    if (enabled && !loading) void reloadAiAccess()
  }, [enabled])
  return useSyncExternalStore(subscribe, () => state)
}

/** Takes in what a save returned, so every view of it agrees without asking again */
export function setAiAccess(me: PersonalAi): void {
  commit({ me, loaded: true, failed: false })
}
