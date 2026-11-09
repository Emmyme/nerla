import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router"
import { ApiError } from "@/lib/api/request"
import { meetingsAPI } from "@/lib/api/meetings"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { CallRoom } from "@/components/call/CallRoom"
import { EndScreen } from "@/components/call/CallEndScreen"
import { endScreen, type EndCopy } from "@/components/call/endScreen"
import { Prejoin, type GuestIdentity } from "@/components/call/Prejoin"
import { GuestLobby } from "@/components/call/GuestLobby"
import { rejoinChoices, type JoinChoices } from "@/components/call/devices"
import { GUEST_BUSY_PAUSE_MS, GUEST_POLL_MS, guestOutcome, type GuestOutcome } from "@/components/call/guestFlow"
import type { GuestPass } from "@/components/call/paperShare"
import { useDocumentTitle } from "@/lib/useDocumentTitle"

type Ended = Exclude<GuestOutcome, "waiting" | "admitted">

type Phase =
  | { kind: "prejoin" }
  | { kind: "waiting"; sessionId: string; secret: string }
  | { kind: "admitted"; token: string; livekitUrl: string | null; pass?: GuestPass }
  | { kind: "ended"; copy: EndCopy; duration?: number }
  | { kind: Ended }

const OUTCOMES: Record<Ended, { title: string; body: string; action?: string }> = {
  denied: { title: "The host didn't let you in", body: "If you think this was a mistake, you can ask again.", action: "Ask again" },
  expired: { title: "Your request timed out", body: "No one answered in time. You can ask again.", action: "Ask again" },
  missing: { title: "This meeting link doesn't work", body: "Check the link with the person who sent it to you." },
  busy: { title: "Too many tries", body: "Wait a minute and try again.", action: "Try again" },
}

const REQUEST_FAILED = "Your request didn't go through. Check your connection and try again."
const REQUEST_REJECTED = "Your request didn't go through. Try again."

function OutcomeScreen({ outcome, onAction }: { outcome: Ended; onAction: () => Promise<void> }) {
  const copy = OUTCOMES[outcome]
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    heading.current?.focus()
  }, [outcome])

  const act = async () => {
    setPending(true)
    setError(null)
    try {
      await onAction()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : REQUEST_FAILED)
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="flex min-h-window items-center justify-center bg-background p-4 sm:p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl border border-border bg-card p-6 text-center">
        <div role="status">
          <h1 ref={heading} tabIndex={-1} className="text-title font-semibold text-foreground outline-none">
            {copy.title}
          </h1>
          <p className="mt-1 text-body text-muted-foreground">{copy.body}</p>
        </div>
        {copy.action && (
          <Button variant="join" onClick={act} disabled={pending} className="w-full">
            {pending && <Spinner className="size-4" />}
            {copy.action}
          </Button>
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

export default function GuestJoinPage() {
  useDocumentTitle("Join meeting")
  const params = useParams()
  const roomId = params.roomId as string

  const [phase, setPhase] = useState<Phase>({ kind: "prejoin" })
  const last = useRef<{ choices: JoinChoices; guest: GuestIdentity } | null>(null)

  const request = async (choices: JoinChoices, guest: GuestIdentity) => {
    last.current = { choices, guest }
    try {
      const { sessionId, secret } = await meetingsAPI.guestRequest(roomId, guest.name)
      setPhase({ kind: "waiting", sessionId, secret })
    } catch (err) {
      if (err instanceof ApiError) {
        const outcome = guestOutcome(err.status, undefined, "request")
        if (outcome === "missing" || outcome === "busy") {
          setPhase({ kind: outcome })
          return
        }
        throw new Error(REQUEST_REJECTED)
      }
      throw new Error(REQUEST_FAILED)
    }
  }

  // Asking again goes back through the lobby with the same name and devices
  const askAgain = async () => {
    if (last.current) await request(last.current.choices, last.current.guest)
    else setPhase({ kind: "prejoin" })
  }

  const sessionId = phase.kind === "waiting" ? phase.sessionId : null
  const secret = phase.kind === "waiting" ? phase.secret : null

  // Closing the tab while waiting takes the request out of the hosts' lobby
  useEffect(() => {
    if (!sessionId || !secret) return
    const cancel = () => meetingsAPI.guestCancelOnExit(sessionId, secret)
    // A page restored from the back cache had its request cancelled on the way out
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) setPhase({ kind: "expired" })
    }
    window.addEventListener("pagehide", cancel)
    window.addEventListener("pageshow", restored)
    return () => {
      window.removeEventListener("pagehide", cancel)
      window.removeEventListener("pageshow", restored)
    }
  }, [sessionId, secret])

  useEffect(() => {
    if (!sessionId || !secret) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      let outcome: GuestOutcome = "waiting"
      let data: Awaited<ReturnType<typeof meetingsAPI.guestStatus>> | undefined
      try {
        data = await meetingsAPI.guestStatus(sessionId, secret)
        outcome = guestOutcome(200, data)
      } catch (err) {
        if (err instanceof ApiError) outcome = guestOutcome(err.status)
      }
      if (stopped) return
      if (outcome === "admitted" && data?.token) {
        // The pass proves the guest to Nerla while they are in the call, for the papers shown there
        const pass =
          data.pass && data.passExpiresAt
            ? { pass: data.pass, expiresAt: data.passExpiresAt, name: `${last.current?.guest.name ?? "Guest"} (Guest)` }
            : undefined
        setPhase({ kind: "admitted", token: data.token, livekitUrl: data.livekitUrl ?? null, pass })
      } else if (outcome === "waiting" || outcome === "admitted") {
        timer = setTimeout(poll, GUEST_POLL_MS)
      } else if (outcome === "busy") {
        timer = setTimeout(poll, GUEST_BUSY_PAUSE_MS)
      } else {
        setPhase({ kind: outcome })
      }
    }
    timer = setTimeout(poll, GUEST_POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [sessionId, secret])

  if (phase.kind === "admitted") {
    return (
      <CallRoom
        guest
        token={phase.token}
        guestPass={phase.pass}
        roomName={roomId}
        livekitUrl={phase.livekitUrl}
        choices={last.current?.choices}
        onEnd={(reason, left, media, duration) => {
          if (last.current) last.current = { ...last.current, choices: rejoinChoices(last.current.choices, media) }
          setPhase({ kind: "ended", copy: endScreen(reason, left, true), duration })
        }}
      />
    )
  }

  if (phase.kind === "waiting") {
    return (
      <GuestLobby
        name={last.current?.guest.name}
        choices={last.current?.choices}
        onCancel={() => {
          meetingsAPI.guestCancel(phase.sessionId, phase.secret).catch(() => {})
          setPhase({ kind: "prejoin" })
        }}
      />
    )
  }

  if (phase.kind === "ended") {
    return <EndScreen copy={phase.copy} duration={phase.duration} rejoinLabel="Ask to join again" onRejoin={askAgain} />
  }

  if (phase.kind === "prejoin") {
    return <Prejoin guest defaultGuest={last.current?.guest} onJoin={(choices, guest) => request(choices, guest!)} />
  }

  return <OutcomeScreen outcome={phase.kind} onAction={askAgain} />
}
