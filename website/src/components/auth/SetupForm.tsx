import { useState, type FormEvent } from "react"
import { missingRulesMessage } from "@/lib/authFlow"
import { authPost, enterApp } from "./authSubmit"
import { AuthHeader, ErrorText, Field, NewPasswordField, SubmitButton, useAuthTask } from "./parts"

/** The first account on an empty server. It becomes the admin and names the workspace. `askCode` when the server wants setup's code */
export function SetupForm({ next, askCode }: { next: string; askCode: boolean }) {
  const [setupCode, setSetupCode] = useState("")
  const [organizationName, setOrganizationName] = useState("")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const { busy, error, errorId, run, fail, clear } = useAuthTask()
  const changePassword = (value: string) => {
    setPassword(value)
    clear()
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const missing = missingRulesMessage(password)
    if (missing) return fail(missing)
    void run(async () =>
      enterApp(
        await authPost("signup", { email, password, firstName, lastName, organizationName, ...(askCode ? { setupCode } : {}) }),
        next,
      ),
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <AuthHeader title="Create your admin account" description="This first account runs your Nerla server." />
      <form onSubmit={submit} className="flex flex-col gap-4">
        {askCode && (
          <Field
            id="setupCode"
            name="setupCode"
            label="Setup code"
            hint="Setup printed it when it finished. It's also SETUP_TOKEN in the server's .env."
            required
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            errorId={errorId}
            value={setupCode}
            onChange={(event) => setSetupCode(event.target.value)}
          />
        )}
        <Field
          id="organizationName"
          name="organizationName"
          label="Workspace name"
          required
          maxLength={255}
          autoComplete="organization"
          value={organizationName}
          onChange={(event) => setOrganizationName(event.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field
            id="firstName"
            name="firstName"
            label="First name"
            required
            maxLength={255}
            autoComplete="given-name"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
          />
          <Field
            id="lastName"
            name="lastName"
            label="Last name"
            required
            maxLength={255}
            autoComplete="family-name"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
          />
        </div>
        <Field
          id="email"
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          errorId={errorId}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <NewPasswordField label="Password" value={password} onChange={changePassword} errorId={errorId} />
        {error && <ErrorText id={errorId}>{error}</ErrorText>}
        <SubmitButton busy={busy} blocked={!!missingRulesMessage(password)} idle="Create account" working="Creating account" />
      </form>
    </div>
  )
}
