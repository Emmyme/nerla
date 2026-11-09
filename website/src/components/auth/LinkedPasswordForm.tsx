import { useState, type FormEvent } from "react"
import { FIELD_LABEL } from "@/components/ui/field-label"
import { missingRulesMessage, type LinkedFlow } from "@/lib/authFlow"
import { authPost, enterApp } from "./authSubmit"
import { AuthHeader, ErrorText, NewPasswordField, SubmitButton, TextButton, useAuthTask } from "./parts"

const COPY = {
  activate: {
    title: "Set your password",
    description: "Choose a password to finish joining your workspace.",
    field: "Password",
    idle: "Set password",
    working: "Setting password",
  },
  reset: {
    title: "Set a new password",
    description: "Choose a new password for your account.",
    field: "New password",
    idle: "Reset password",
    working: "Resetting",
  },
}

/** Invite and reset links land here. Both choose a password with the token the link carries. */
export function LinkedPasswordForm({ flow, next, onSignIn }: { flow: LinkedFlow; next: string; onSignIn: () => void }) {
  const [password, setPassword] = useState("")
  const { busy, error, errorId, run, fail, clear } = useAuthTask()
  const changePassword = (value: string) => {
    setPassword(value)
    clear()
  }
  const copy = COPY[flow.mode]
  const { token, email } = flow
  const complete = !!token && (flow.mode === "reset" || !!email)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!complete) return
    const missing = missingRulesMessage(password)
    if (missing) return fail(missing)
    const body = flow.mode === "activate" ? { email, password, token } : { token, password }
    void run(async () => enterApp(await authPost(flow.mode === "activate" ? "set-password" : "reset-password", body), next))
  }

  if (!complete) {
    return (
      <div className="flex flex-col gap-6">
        <AuthHeader title={copy.title} />
        <ErrorText>This link is incomplete. Ask for a new one.</ErrorText>
        <p className="text-center text-ui">
          <TextButton onClick={onSignIn}>Back to sign in</TextButton>
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <AuthHeader title={copy.title} description={copy.description} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        {email && (
          <input
            type="email"
            name="username"
            autoComplete="username"
            value={email}
            readOnly
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
          />
        )}
        {flow.mode === "activate" && (
          <div className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Email</span>
            <span className="text-ui font-medium wrap-anywhere text-foreground">{email}</span>
          </div>
        )}
        <NewPasswordField label={copy.field} value={password} onChange={changePassword} errorId={errorId} />
        {error && <ErrorText id={errorId}>{error}</ErrorText>}
        <SubmitButton busy={busy} blocked={!!missingRulesMessage(password)} idle={copy.idle} working={copy.working} />
      </form>
      <p className="text-center text-ui text-muted-foreground">
        {flow.mode === "activate" && "Already have a password? "}
        <TextButton onClick={onSignIn}>{flow.mode === "activate" ? "Sign in" : "Back to sign in"}</TextButton>
      </p>
    </div>
  )
}
