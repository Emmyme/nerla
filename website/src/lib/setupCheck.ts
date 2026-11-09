import { useSyncExternalStore } from "react"
import { setupAPI, type SetupItem } from "@/lib/api/setup"

type SetupCheckState = { items: SetupItem[] | null; error: unknown; checking: boolean }

let state: SetupCheckState = { items: null, error: null, checking: false }
let running: Promise<void> | null = null
const listeners = new Set<() => void>()

function update(next: Partial<SetupCheckState>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

/** Asks the server once a session, so the settings menu can show the problem count without asking on every visit */
export function loadSetupCheck({ again = false } = {}): Promise<void> {
  if (running) return running
  if (state.items && !again) return Promise.resolve()
  update({ checking: true, error: null })
  running = setupAPI
    .check()
    .then(
      (items) => update({ items, checking: false }),
      (error: unknown) => update({ error, checking: false }),
    )
    .finally(() => {
      running = null
    })
  return running
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSetupCheck(): SetupCheckState {
  return useSyncExternalStore(subscribe, () => state)
}

export const problemCount = (items: SetupItem[] | null) => items?.filter((item) => item.status === "problem").length ?? 0
