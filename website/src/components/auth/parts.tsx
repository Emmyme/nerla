import { useEffect, useId, useState, type ComponentProps, type ReactNode } from "react"
import { Check, Circle } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LoadingSpinner } from "@/components/ui/spinner"
import { FIELD_LABEL, TEXT_LINK } from "@/components/ui/field-label"
import { passwordRules } from "@/lib/authFlow"
import { cn } from "@/lib/utils"
import { FAILED } from "./authSubmit"

export function AuthHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h1
        tabIndex={-1}
        className="rounded-sm text-title font-semibold text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
      >
        {title}
      </h1>
      {description && <p className="text-ui text-muted-foreground">{description}</p>}
    </div>
  )
}

const describedBy = (...ids: (string | undefined)[]) => ids.filter(Boolean).join(" ") || undefined

export function Field({
  id,
  label,
  hint,
  errorId,
  invalid,
  ...props
}: ComponentProps<typeof Input> & { id: string; label: string; hint?: string; errorId?: string; invalid?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      <Input id={id} aria-describedby={describedBy(hint && `${id}-hint`, errorId)} aria-invalid={invalid || undefined} {...props} />
      {hint && (
        <p id={`${id}-hint`} className="text-caption text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

/** A new password with the server's rules ticked off as they are met */
export function NewPasswordField({
  label,
  value,
  onChange,
  errorId,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  errorId?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="password" className={FIELD_LABEL}>
        {label}
      </label>
      <Input
        id="password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        aria-describedby={describedBy("password-rules", errorId)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <ul id="password-rules" aria-label="Your password needs" className="mt-1 flex flex-col gap-1 text-caption">
        {passwordRules(value).map((rule) => (
          <li key={rule.id} className={cn("flex items-center gap-1.5", rule.met ? "text-foreground" : "text-muted-foreground")}>
            {rule.met ? (
              <span
                aria-hidden="true"
                className="flex size-3.5 items-center justify-center rounded-full bg-app-pistachio text-app-pistachio-ink"
              >
                <Check weight="bold" className="size-2.5" />
              </span>
            ) : (
              <Circle aria-hidden="true" className="size-3.5" />
            )}
            {rule.label}
            {rule.met && <span className="sr-only">, done</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A status region that mounts empty and fills after, so screen readers announce what it says */
function Live({ children, className }: { children: ReactNode; className?: string }) {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  return (
    <div role="status" className={className}>
      {ready ? children : null}
    </div>
  )
}

export function Notice({ tone, children, className }: { tone: "success" | "warning"; children: ReactNode; className?: string }) {
  const box = cn(
    "rounded-lg px-3.5 py-2.5 text-ui",
    tone === "success" ? "bg-app-pistachio-soft text-app-pistachio-ink" : "bg-app-lemon-soft text-app-lemon-ink",
  )
  if (tone === "warning") return <p className={cn(box, className)}>{children}</p>
  return (
    <Live className={className}>
      <p className={box}>{children}</p>
    </Live>
  )
}

export function ErrorText({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-ui text-app-berry-text">
      {children}
    </p>
  )
}

/**
 * Stays focusable while busy or blocked, so focus stays on it when an error comes back. A blocked submit
 * still reaches the form, which says what is missing.
 */
export function SubmitButton({ busy, blocked, idle, working }: { busy: boolean; blocked?: boolean; idle: string; working: string }) {
  return (
    <Button
      type="submit"
      className="w-full"
      aria-disabled={busy || blocked || undefined}
      aria-busy={busy || undefined}
      onClick={(event) => {
        if (busy) event.preventDefault()
      }}
    >
      {busy ? working : idle}
    </Button>
  )
}

export function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={TEXT_LINK}>
      {children}
    </button>
  )
}

/** A waiting panel, used while the server is probed or asks the app to slow down */
export function Waiting({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <LoadingSpinner size="lg" role="presentation" aria-hidden="true" />
      <Live className="text-ui text-muted-foreground">{children}</Live>
    </div>
  )
}

/** Runs one auth request at a time and keeps its error. The task returns true when the page is leaving. */
export function useAuthTask() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const id = useId()
  const fail = (message: string) => setError(message)
  const run = async (task: () => Promise<boolean | void>) => {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      if (await task()) return
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : FAILED)
    }
    setBusy(false)
  }
  const clear = () => setError("")
  return { busy, error, errorId: error ? id : undefined, run, fail, clear }
}
