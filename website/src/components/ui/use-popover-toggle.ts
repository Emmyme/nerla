import { useRef } from "react"

/**
 * A press on the button that opened a non-modal popover first closes it as a press outside,
 * so the click must not open it again.
 */
export function usePopoverToggle(open: boolean, setOpen: (open: boolean) => void) {
  const wasOpen = useRef<boolean | null>(null)
  return {
    onPointerDown: () => {
      wasOpen.current = open
    },
    onClick: () => {
      const was = wasOpen.current ?? open
      wasOpen.current = null
      setOpen(!was)
    },
  }
}
