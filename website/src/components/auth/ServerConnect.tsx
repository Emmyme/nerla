import { useId, useState, type FormEvent } from "react"
import type { ProbeResult } from "@/lib/authFlow"
import { setServerUrl, verifyNerlaServer } from "@/lib/serverUrl"
import { AuthHeader, ErrorText, Field, SubmitButton, TextButton, useAuthTask } from "./parts"

/** Asks for the server address. Only the desktop app or a failed probe shows it. */
export function ServerConnect({
  initialUrl,
  reason,
  onResult,
  onCancel,
}: {
  initialUrl: string
  reason?: string
  onResult: (url: string, result: Exclude<ProbeResult, { ok: false; busy?: false }>) => void
  onCancel?: () => void
}) {
  const [url, setUrl] = useState(initialUrl)
  const { busy, error, errorId, run } = useAuthTask()
  const problem = error || reason
  const problemId = useId()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      const normalized = await setServerUrl(url)
      setUrl(normalized)
      const result = await verifyNerlaServer(normalized)
      if (!result.ok && !result.busy) throw new Error(result.reason)
      onResult(normalized, result)
      return true
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <AuthHeader title="Connect to your server" description="Enter the address of your Nerla server." />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          id="serverUrl"
          name="serverUrl"
          label="Server URL"
          type="url"
          required
          autoComplete="url"
          hint="For example https://nerla.example.com"
          errorId={problem ? (errorId ?? problemId) : undefined}
          invalid={!!problem}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        {problem && <ErrorText id={errorId ?? problemId}>{problem}</ErrorText>}
        <SubmitButton busy={busy} idle="Connect" working="Connecting" />
      </form>
      {onCancel && (
        <p className="text-center text-ui">
          <TextButton onClick={onCancel}>Cancel</TextButton>
        </p>
      )}
    </div>
  )
}
