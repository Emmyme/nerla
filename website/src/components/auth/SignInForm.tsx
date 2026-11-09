import { useState, type FormEvent } from "react"
import { authPost, enterApp } from "./authSubmit"
import { AuthHeader, ErrorText, Field, SubmitButton, TextButton, useAuthTask } from "./parts"

export function SignInForm({
  next,
  email,
  onEmail,
  onForgot,
}: {
  next: string
  email: string
  onEmail: (email: string) => void
  onForgot: () => void
}) {
  const [password, setPassword] = useState("")
  const { busy, error, errorId, run } = useAuthTask()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => enterApp(await authPost("signin", { email, password }), next))
  }

  return (
    <div className="flex flex-col gap-6">
      <AuthHeader title="Sign in" description="Use the email and password for your workspace." />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          id="email"
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          errorId={errorId}
          invalid={!!error}
          value={email}
          onChange={(event) => onEmail(event.target.value)}
        />
        <Field
          id="password"
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          errorId={errorId}
          invalid={!!error}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error && <ErrorText id={errorId}>{error}</ErrorText>}
        <SubmitButton busy={busy} idle="Sign in" working="Signing in" />
      </form>
      <p className="text-center text-ui">
        <TextButton onClick={onForgot}>Forgot your password?</TextButton>
      </p>
    </div>
  )
}
