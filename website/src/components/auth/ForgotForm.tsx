import { useState, type FormEvent } from "react"
import { authPost } from "./authSubmit"
import { AuthHeader, ErrorText, Field, Notice, SubmitButton, TextButton, useAuthTask } from "./parts"

export function ForgotForm({ email, onEmail, onBack }: { email: string; onEmail: (email: string) => void; onBack: () => void }) {
  const [sentTo, setSentTo] = useState<string | null>(null)
  const { busy, error, errorId, run } = useAuthTask()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      await authPost("forgot-password", { email })
      setSentTo(email)
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {sentTo ? (
        <AuthHeader title="Check your email" />
      ) : (
        <AuthHeader title="Reset your password" description="Enter your email and we'll send you a link to reset your password." />
      )}
      {sentTo ? (
        <Notice tone="success">
          If an account exists for {sentTo}, a reset link is on its way. No email after a few minutes? An admin can see in the setup check
          if it failed, or find the link in the server log if email isn't set up.
        </Notice>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field
            id="email"
            name="email"
            label="Email"
            type="email"
            autoComplete="email"
            required
            errorId={errorId}
            value={email}
            onChange={(event) => onEmail(event.target.value)}
          />
          {error && <ErrorText id={errorId}>{error}</ErrorText>}
          <SubmitButton busy={busy} idle="Send reset link" working="Sending" />
        </form>
      )}
      <p className="text-center text-ui">
        <TextButton onClick={onBack}>Back to sign in</TextButton>
      </p>
    </div>
  )
}
