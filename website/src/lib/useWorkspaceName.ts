import { useSyncExternalStore } from "react"
import { organizationsAPI } from "@/lib/api/organizations"

let name: string | null = null
let requested = false
const listeners = new Set<() => void>()

/** Shares the workspace name, so the settings page's own read of the organization updates the sidebar too */
export function publishWorkspaceName(next: string | null) {
  requested = true
  if (next === name) return
  name = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!requested) {
    requested = true
    organizationsAPI.getCurrentOrganization().then(
      (org) => publishWorkspaceName(org?.name ?? null),
      () => {
        requested = false
      },
    )
  }
  return () => {
    listeners.delete(listener)
  }
}

export function useWorkspaceName(): string | null {
  return useSyncExternalStore(subscribe, () => name)
}
