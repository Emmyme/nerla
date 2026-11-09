import { useCallback, useEffect, useRef } from "react"
import { useBlocker } from "react-router"
import { useDiscardGuard } from "@/components/calendar/DiscardDialog"

/** Asks before leaving a settings page with unsaved changes, in the app and when the tab closes. Render the returned dialog. */
export function useLeaveGuard(changed: boolean): JSX.Element {
  const dirty = useCallback(() => changed, [changed])
  const [guard, discardDialog] = useDiscardGuard(dirty)
  const blocker = useBlocker(({ currentLocation, nextLocation }) => changed && currentLocation.pathname !== nextLocation.pathname)
  const blockerRef = useRef(blocker)
  blockerRef.current = blocker

  useEffect(() => {
    if (blocker.state === "blocked")
      guard(
        () => blockerRef.current.proceed?.(),
        () => blockerRef.current.reset?.(),
      )
  }, [blocker.state, guard])

  useEffect(() => {
    if (!changed) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [changed])

  return discardDialog
}
