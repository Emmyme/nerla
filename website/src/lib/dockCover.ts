import { useEffect, useSyncExternalStore } from "react"

// How many panels that take the bottom right corner are open, such as the task panel and the event editor
let covers = 0
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A panel that needs the bottom right corner asks the docked chat to step aside while it is open */
export function useCoverDock(open = true) {
  useEffect(() => {
    if (!open) return
    covers += 1
    emit()
    return () => {
      covers -= 1
      emit()
    }
  }, [open])
}

/** True while any such panel is open */
export function useDockCovered(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => covers > 0,
    () => false,
  )
}
