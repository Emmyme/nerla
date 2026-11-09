import type { ReactNode } from "react"
import { useOpenTransition } from "@/lib/motion"

/**
 * Opens and closes its content with a short height and opacity transition. Closed content is hidden, so it
 * cannot take focus. `unmountClosed` drops the content while closed, for long lists.
 */
export function Collapse({
  open,
  children,
  id,
  className,
  unmountClosed = false,
}: {
  open: boolean
  children: ReactNode
  id?: string
  className?: string
  unmountClosed?: boolean
}) {
  const { ref, expanded, settled, hidden } = useOpenTransition(open)
  return (
    <div
      ref={ref}
      id={id}
      hidden={hidden}
      data-open={expanded ? "" : undefined}
      data-settled={settled ? "" : undefined}
      className="motion-collapse"
    >
      <div className={className}>{unmountClosed && hidden ? null : children}</div>
    </div>
  )
}
