import { useEffect, useRef, useState } from "react"
import { Clock, PhoneDisconnect, WifiSlash } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { formatCallLength } from "@/lib/dates"
import { CONNECTION_LOST, type EndCopy } from "./endScreen"

const REJOIN_FAILED = "That didn't work. Check your connection and try again."

/** What follows a call, in the app's own mode: why it ended, which call and how long, and the way back in when there is one */
export function EndScreen({
  copy,
  title,
  duration,
  rejoinLabel = "Rejoin",
  onRejoin,
  onBack,
  backLabel = "Back to calendar",
}: {
  copy: EndCopy
  /** Members only, a guest never learns the meeting's name */
  title?: string
  /** How long the user was connected */
  duration?: number
  rejoinLabel?: string
  onRejoin: () => Promise<void>
  /** Members only, guests have no calendar to go back to */
  onBack?: () => void
  /** "Back to chat" for a call started from a chat */
  backLabel?: string
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lost = copy.title === CONNECTION_LOST
  const Icon = lost ? WifiSlash : PhoneDisconnect

  useEffect(() => {
    heading.current?.focus()
  }, [copy.title])

  const rejoin = async () => {
    setPending(true)
    setError(null)
    try {
      await onRejoin()
    } catch (err) {
      console.error("Rejoin failed:", err)
      setError(err instanceof Error && err.message ? err.message : REJOIN_FAILED)
      setPending(false)
    }
  }

  return (
    <main className="flex min-h-window items-center justify-center bg-background p-4 sm:p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-xl border border-border bg-card p-6 text-center">
        <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-app-sunk">
          <Icon className={lost ? "size-6 text-app-berry-text" : "size-6 text-muted-foreground"} />
        </span>
        <div>
          <h1 ref={heading} tabIndex={-1} className="text-title font-semibold text-foreground outline-none">
            {copy.title}
          </h1>
          {copy.body && <p className="mt-1 text-body text-muted-foreground">{copy.body}</p>}
        </div>
        {(title || duration !== undefined) && (
          <div className="flex w-full min-w-0 flex-col items-center gap-0.5 rounded-lg bg-app-sunk px-4 py-3">
            {title && <p className="w-full truncate text-ui font-medium text-foreground">{title}</p>}
            {duration !== undefined && (
              <p className="flex items-center gap-1.5 text-caption text-muted-foreground tabular-nums">
                <Clock aria-hidden="true" className="size-3.5" />
                <span className="sr-only">Call length</span>
                {formatCallLength(duration)}
              </p>
            )}
          </div>
        )}
        {(copy.rejoin || onBack) && (
          <div className="flex w-full flex-col gap-2">
            {copy.rejoin && (
              <Button variant="join" onClick={rejoin} disabled={pending} className="w-full">
                {pending && <Spinner className="size-4" />}
                {rejoinLabel}
              </Button>
            )}
            {onBack && (
              <Button variant={copy.rejoin ? "ghost" : "outline"} onClick={onBack} className="w-full">
                {backLabel}
              </Button>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-caption text-app-berry-text">
            {error}
          </p>
        )}
      </div>
    </main>
  )
}
