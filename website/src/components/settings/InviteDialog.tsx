import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react"
import { toast } from "sonner"
import { Check, Copy } from "@/components/icons"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FIELD_LABEL } from "@/components/ui/field-label"
import { organizationsAPI } from "@/lib/api/organizations"
import { formatLongDate, parseServerDate } from "@/lib/dates"
import { messageOf } from "@/lib/taskStore"
import { useCopied } from "@/lib/useCopied"
import { inviteOutcome, type InviteOutcome } from "./inviteOutcome"

export type Role = "member" | "admin"

export const ROLES: { value: Role; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
]

const NAME_MAX = 255
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVITE_FAILED = "Couldn't send the invite. Try again."
const COPY_FAILED = "Couldn't copy the link. Select it and copy it yourself."

/**
 * navigator.clipboard needs a secure context, which a plain HTTP install lacks. The fallback copies the
 * selection of `field`, a visible input inside any open dialog, since a dialog's focus trap would take
 * focus off a hidden textarea added to the body and lose its selection.
 */
export async function copyToClipboard(text: string, field?: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // The legacy path below may still work
  }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const temporary = field ? null : document.createElement("textarea")
  try {
    const target = field ?? temporary!
    if (temporary) {
      temporary.value = text
      temporary.readOnly = true
      temporary.style.position = "fixed"
      temporary.style.opacity = "0"
      document.body.appendChild(temporary)
    }
    target.focus()
    target.select()
    target.setSelectionRange(0, target.value.length)
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    temporary?.remove()
    if (previous?.isConnected && previous !== document.activeElement) previous.focus()
  }
}

/** A link that is only shown once, with a copy button and when it stops working */
export function InviteLink({ outcome }: { outcome: Extract<InviteOutcome, { kind: "link" }> }) {
  const field = useRef<HTMLInputElement>(null)
  const [copied, markCopied] = useCopied()
  const expires = formatLongDate(parseServerDate(outcome.expiresAt))

  const copy = async () => {
    if (await copyToClipboard(outcome.url, field.current)) return markCopied()
    toast.error(COPY_FAILED)
    field.current?.focus()
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 max-sm:flex-col">
        <Input
          ref={field}
          readOnly
          value={outcome.url}
          aria-label="Invite link"
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 font-mono text-caption sm:flex-1"
        />
        <Button type="button" variant="outline" className="shrink-0" onClick={() => void copy()}>
          {copied ? <Check aria-hidden="true" className="size-[1rem]" /> : <Copy aria-hidden="true" className="size-[1rem]" />}
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
      <div className="flex flex-col gap-0.5 text-caption text-muted-foreground">
        {expires && <p>Expires {expires}</p>}
        {outcome.emailing ? (
          <p>We're emailing it to {outcome.email}. You can also copy the link above.</p>
        ) : (
          <p>Email isn't set up on this server, so copy the link above and send it yourself.</p>
        )}
      </div>
    </div>
  )
}

const TITLES: Record<InviteOutcome["kind"], string> = { link: "Invite link ready", rejoin: "Invited back", error: "Invite created" }

export function InviteDialog({
  open,
  onClose,
  onInvited,
  pendingEmails,
  memberEmails,
}: {
  open: boolean
  onClose: () => void
  onInvited: () => void
  /** Users already waiting on an invite, who need a new link rather than a second invite */
  pendingEmails: string[]
  /** Users already in the workspace */
  memberEmails: string[]
}) {
  const [outcome, setOutcome] = useState<InviteOutcome | null>(null)
  const emailField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) setOutcome(null)
  }, [open])

  return (
    <BaseModal
      isOpen={open}
      onClose={onClose}
      title={outcome ? TITLES[outcome.kind] : "Invite member"}
      maxWidth="md"
      initialFocus={() => emailField.current}
    >
      {outcome ? (
        <div className="flex flex-col gap-4 p-6">
          {outcome.kind === "link" && (
            <>
              <p className="text-body leading-[1.5] text-muted-foreground">
                Send this link to <span className="font-medium text-foreground">{outcome.email}</span> so they can set a password and join.
              </p>
              <InviteLink outcome={outcome} />
            </>
          )}
          {outcome.kind === "rejoin" && (
            <div className="flex flex-col gap-2 text-body leading-[1.5] text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">{outcome.email}</span> can rejoin by signing in with their existing password.
                The invite lasts 7 days.
              </p>
              {outcome.emailing ? (
                <p>We're emailing them to let them know.</p>
              ) : (
                <p>Email isn't set up on this server, so let them know yourself.</p>
              )}
            </div>
          )}
          {outcome.kind === "error" && (
            <p role="alert" className="text-body leading-[1.5] text-app-berry-text">
              The server didn't send back a usable link. Find {outcome.email} under Pending invitations and use New link.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOutcome(null)
                requestAnimationFrame(() => emailField.current?.focus())
              }}
            >
              Invite another
            </Button>
            <Button type="button" autoFocus onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <InviteForm
          emailField={emailField}
          pendingEmails={pendingEmails}
          memberEmails={memberEmails}
          onCancel={onClose}
          onDone={(next) => {
            setOutcome(next)
            onInvited()
          }}
        />
      )}
    </BaseModal>
  )
}

function InviteForm({
  emailField,
  pendingEmails,
  memberEmails,
  onCancel,
  onDone,
}: {
  emailField: RefObject<HTMLInputElement>
  pendingEmails: string[]
  memberEmails: string[]
  onCancel: () => void
  onDone: (outcome: InviteOutcome) => void
}) {
  const [email, setEmail] = useState("")
  const [first, setFirst] = useState("")
  const [last, setLast] = useState("")
  const [role, setRole] = useState<Role>("member")
  const [tried, setTried] = useState(false)
  const [sending, setSending] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const ids = useId()

  const address = email.trim()
  const known = (list: string[]) => list.some((other) => other.toLowerCase() === address.toLowerCase())
  const emailError = !address
    ? "Enter an email address."
    : !EMAIL.test(address)
      ? "Enter a valid email address."
      : known(memberEmails)
        ? `${address} is already in this workspace.`
        : known(pendingEmails)
          ? "This person already has a pending invitation. Use New link in the list instead."
          : null
  const showError = tried && emailError

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTried(true)
    if (emailError || sending) {
      if (emailError) emailField.current?.focus()
      return
    }
    setSending(true)
    setServerError(null)
    try {
      const res = await organizationsAPI.inviteUser(address, first.trim() || undefined, last.trim() || undefined, role)
      onDone(inviteOutcome(res, address))
    } catch (err) {
      setServerError(messageOf(err, INVITE_FAILED))
      setSending(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-email`} className={FIELD_LABEL}>
          Email
        </label>
        <Input
          ref={emailField}
          id={`${ids}-email`}
          type="email"
          value={email}
          maxLength={NAME_MAX}
          autoComplete="off"
          aria-required="true"
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={showError ? true : undefined}
          aria-describedby={showError ? `${ids}-email-error` : undefined}
        />
        {showError && (
          <FieldError id={`${ids}-email-error`} className="mt-0">
            {emailError}
          </FieldError>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-first`} className={FIELD_LABEL}>
            First name
          </label>
          <Input
            id={`${ids}-first`}
            value={first}
            maxLength={NAME_MAX}
            autoComplete="off"
            onChange={(event) => setFirst(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-last`} className={FIELD_LABEL}>
            Last name
          </label>
          <Input
            id={`${ids}-last`}
            value={last}
            maxLength={NAME_MAX}
            autoComplete="off"
            onChange={(event) => setLast(event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-role`} className={FIELD_LABEL}>
          Role
        </label>
        <Select value={role} onValueChange={(value) => setRole(value as Role)}>
          <SelectTrigger id={`${ids}-role`} className="sm:w-[10rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-ui">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {serverError && (
        <p role="alert" className="text-ui text-app-berry-text">
          {serverError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={sending}>
          Cancel
        </Button>
        <Button type="submit" disabled={sending} aria-busy={sending || undefined}>
          {sending ? "Inviting" : "Invite"}
        </Button>
      </div>
    </form>
  )
}
