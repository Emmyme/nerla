import { useSyncExternalStore } from "react"
import type { ShortcutScope } from "@/lib/shortcuts"

/** Whether the shortcuts dialog is open, and the one group it shows when opened at a section */
type ShortcutsDialogState = { open: boolean; section: ShortcutScope | null }

let state: ShortcutsDialogState = { open: false, section: null }
const listeners = new Set<() => void>()

function set(next: ShortcutsDialogState) {
  state = next
  for (const listener of listeners) listener()
}

/** Opens the shortcuts dialog, showing only one group such as `{ section: "boards" }` when one is given */
export const openShortcuts = ({ section = null }: { section?: ShortcutScope | null } = {}) => set({ open: true, section })
export const closeShortcuts = () => state.open && set({ ...state, open: false })

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useShortcutsDialog(): ShortcutsDialogState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
}

export const useShortcutsOpen = () => useShortcutsDialog().open
