import type { ReactNode } from "react"
import { TEXT_LINK } from "@/components/ui/field-label"
import { BUSY_MESSAGE } from "@/lib/authFlow"

/** A load that failed, with a Try again that is a full touch target on phones */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p role="alert" className="text-body text-app-berry-text">
      {message}{" "}
      <button type="button" onClick={onRetry} className={TEXT_LINK}>
        Try again
      </button>
    </p>
  )
}

/** Placeholder rows while a section loads, saying so when the server asked the app to wait */
export function LoadingRows({ label, busy, children }: { label: string; busy: boolean; children: ReactNode }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-2">
      <p role="status" className={busy ? "text-ui text-muted-foreground" : "sr-only"}>
        {busy ? BUSY_MESSAGE : label}
      </p>
      {children}
    </div>
  )
}
