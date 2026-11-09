import { useCallback, useSyncExternalStore } from "react"

const DESKTOP_QUERY = "(min-width: 64rem)"

/** Whether the query matches right now, or the fallback where there is no matchMedia */
export function matchesMedia(query: string, fallback = false): boolean {
  try {
    return typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback
  } catch {
    return fallback
  }
}

export function useMediaQuery(query: string, fallback = true): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {}
      const list = window.matchMedia(query)
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => matchesMedia(query, fallback),
    () => fallback,
  )
}

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY)
}
