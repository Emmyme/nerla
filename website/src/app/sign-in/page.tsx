import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router"
import { isTauri } from "@tauri-apps/api/core"
import { AuthLayout } from "@/components/auth/AuthLayout"
import { ForgotForm } from "@/components/auth/ForgotForm"
import { LinkedPasswordForm } from "@/components/auth/LinkedPasswordForm"
import { Notice, TextButton, Waiting } from "@/components/auth/parts"
import { ServerConnect } from "@/components/auth/ServerConnect"
import { SetupForm } from "@/components/auth/SetupForm"
import { SignInForm } from "@/components/auth/SignInForm"
import { BUSY_MESSAGE, parseLinkedFlow, withoutToken, type ProbeResult } from "@/lib/authFlow"
import { getServerUrl, isInsecureUrl, verifyNerlaServer } from "@/lib/serverUrl"
import { returnPath } from "@/lib/signInReturn"
import { useDocumentTitle } from "@/lib/useDocumentTitle"

type Mode = "signin" | "setup" | "activate" | "forgot" | "reset"
type Screen = { kind: "connecting" } | { kind: "busy" } | { kind: "connect"; reason?: string; back?: "ready" | "probe" } | { kind: "ready" }

const TITLES: Record<Mode | "connect", string> = {
  signin: "Sign in",
  setup: "Create your admin account",
  activate: "Set your password",
  forgot: "Reset your password",
  reset: "Set a new password",
  connect: "Connect to your server",
}

export default function SignInPage() {
  const next = returnPath(useSearchParams()[0].get("next"))
  const linked = useMemo(() => parseLinkedFlow(window.location.search, window.location.hash), [])
  const [screen, setScreen] = useState<Screen>({ kind: "connecting" })
  const [mode, setMode] = useState<Mode>("signin")
  const [serverUrl, setServerUrl] = useState("")
  const [email, setEmail] = useState(linked?.email ?? "")
  const [setupCode, setSetupCode] = useState(false)
  const [attempt, setAttempt] = useState<{ url: string; fromLink: boolean } | null>(null)
  const retry = useRef<ReturnType<typeof setTimeout>>()
  const view = screen.kind === "ready" ? mode : screen.kind
  useDocumentTitle(view === "connecting" || view === "busy" ? TITLES.signin : TITLES[view])

  // A new form moves focus to its heading, except the first one the page opens on
  const opened = useRef(false)
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>("main h1")
    if (opened.current) heading?.focus()
    else opened.current = !!heading
  }, [view])

  // The link's token is read once, then kept out of history and out of any shared address
  useEffect(() => {
    if (linked?.token) window.history.replaceState(window.history.state, "", withoutToken(window.location.href))
  }, [linked])

  const apply = useCallback(
    (url: string, result: ProbeResult, fromLink: boolean) => {
      clearTimeout(retry.current)
      setServerUrl(url)
      if (result.ok) {
        setMode((fromLink && linked?.mode) || (result.needsSetup ? "setup" : "signin"))
        setSetupCode(result.setupCode)
        setScreen({ kind: "ready" })
      } else if (result.busy) {
        // Busy is still reachable, so it waits and asks again rather than offering another server
        setScreen({ kind: "busy" })
        retry.current = setTimeout(() => setAttempt({ url, fromLink }), result.retryMs)
      } else {
        setScreen({ kind: "connect", reason: result.reason })
      }
    },
    [linked],
  )

  useEffect(() => {
    let live = true
    void getServerUrl().then((url) => {
      if (!live) return
      setServerUrl(url)
      setAttempt({ url, fromLink: true })
    })
    return () => {
      live = false
      clearTimeout(retry.current)
    }
  }, [])

  useEffect(() => {
    if (!attempt) return
    let live = true
    void verifyNerlaServer(attempt.url).then((result) => live && apply(attempt.url, result, attempt.fromLink))
    return () => {
      live = false
    }
  }, [attempt, apply])

  const toSignIn = () => setMode("signin")

  const change = () => {
    clearTimeout(retry.current)
    setAttempt(null)
    setScreen({ kind: "connect", back: screen.kind === "ready" ? "ready" : "probe" })
  }

  const cancelChange = () => {
    if (screen.kind === "connect" && screen.back === "ready") return setScreen({ kind: "ready" })
    setScreen({ kind: "connecting" })
    setAttempt({ url: serverUrl, fromLink: true })
  }

  const footer =
    isTauri() && serverUrl ? (
      <>
        Connected to {serverUrl} · <TextButton onClick={change}>Change</TextButton>
      </>
    ) : undefined

  if (screen.kind === "connecting") {
    return (
      <AuthLayout footer={footer}>
        <Waiting>Connecting to your server</Waiting>
      </AuthLayout>
    )
  }

  if (screen.kind === "busy") {
    return (
      <AuthLayout footer={footer}>
        <Waiting>{BUSY_MESSAGE}</Waiting>
      </AuthLayout>
    )
  }

  if (screen.kind === "connect") {
    return (
      <AuthLayout>
        <ServerConnect
          initialUrl={serverUrl}
          reason={screen.reason}
          onResult={(url, result) => apply(url, result, false)}
          onCancel={screen.back ? cancelChange : undefined}
        />
      </AuthLayout>
    )
  }

  return (
    <AuthLayout footer={footer}>
      {mode === "setup" ? (
        <SetupForm next={next} askCode={setupCode} />
      ) : (mode === "activate" || mode === "reset") && linked ? (
        <LinkedPasswordForm flow={linked} next={next} onSignIn={toSignIn} />
      ) : mode === "forgot" ? (
        <ForgotForm email={email} onEmail={setEmail} onBack={toSignIn} />
      ) : (
        <SignInForm next={next} email={email} onEmail={setEmail} onForgot={() => setMode("forgot")} />
      )}
      {isInsecureUrl(serverUrl) && (
        <Notice tone="warning" className="mt-6">
          This server uses plain HTTP, so your password travels unencrypted. Use HTTPS in production.
        </Notice>
      )}
    </AuthLayout>
  )
}
