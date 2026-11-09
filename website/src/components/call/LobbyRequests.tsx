import { useCallback, useEffect, useRef, useState } from "react"
import { useConnectionState } from "@livekit/components-react"
import { ConnectionState } from "livekit-client"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { UserAvatar } from "@/components/ui/user-avatar"
import { ApiError } from "@/lib/api/request"
import { meetingsAPI } from "@/lib/api/meetings"
import { sameRoom } from "@/lib/meetingWindow"
import { onLobbyRequest, onLobbyResolved, onSocketReconnect } from "@/lib/socket"
import { guestAvatar } from "./avatar"
import { CALL_TOAST_SURFACE, CALL_TOASTER } from "./incoming"
import { mergeLobby, type LobbyEntry, type LobbyEvent } from "./lobby"

export type Lobby = {
  isHost: boolean
  entries: LobbyEntry[]
  busy: ReadonlySet<string>
  answer: (entry: LobbyEntry, admit: boolean) => Promise<void>
}

const toastId = (sessionId: string) => `lobby-${sessionId}`

function LobbyToast({ entry, onAdmit, onView }: { entry: LobbyEntry; onAdmit: () => Promise<void>; onView: () => void }) {
  const [pending, setPending] = useState(false)
  return (
    <div className={CALL_TOAST_SURFACE}>
      <UserAvatar user={guestAvatar(entry.guestName)} size="md" />
      <p className="min-w-0 flex-1 text-ui text-app-text">
        <span className="font-medium break-words">{entry.guestName}</span> wants to join
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={onView} aria-label={`View ${entry.guestName}'s request`}>
          View
        </Button>
        <Button
          size="sm"
          disabled={pending}
          aria-label={`Admit ${entry.guestName}`}
          onClick={() => {
            setPending(true)
            void onAdmit().finally(() => setPending(false))
          }}
        >
          {pending && <Spinner className="size-3.5" />}
          Admit
        </Button>
      </div>
    </div>
  )
}

/**
 * Guests waiting for this room. Hosts are found out, not told: the replay answers only hosts,
 * and the server sends live requests only to hosts.
 */
export function useLobby(roomName: string, { enabled, quiet, onView }: { enabled: boolean; quiet: boolean; onView: () => void }): Lobby {
  const [entries, setEntries] = useState<LobbyEntry[]>([])
  const [isHost, setIsHost] = useState(false)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const resolved = useRef(new Set<string>())
  // When each request arrived live, so a replay can tell the ones it raced from the ones it outdates
  const arrived = useRef(new Map<string, number>())
  const clock = useRef(0)
  const connected = useConnectionState() === ConnectionState.Connected
  const [socketEpoch, setSocketEpoch] = useState(0)

  const apply = useCallback((event: LobbyEvent) => {
    if (event.type === "resolved") resolved.current.add(event.sessionId)
    if (event.type === "request") arrived.current.set(event.entry.sessionId, ++clock.current)
    const next: LobbyEvent =
      event.type === "replay" ? { ...event, entries: event.entries.filter((e) => !resolved.current.has(e.sessionId)) } : event
    setEntries((current) => mergeLobby(current, next))
  }, [])

  useEffect(() => {
    if (!enabled) return
    const offRequest = onLobbyRequest((data) => {
      if (!sameRoom(data.roomName, roomName)) return
      setIsHost(true)
      apply({ type: "request", entry: { sessionId: data.sessionId, guestName: data.guestName } })
    })
    // Requests and outcomes sent while the app socket was down are lost, so it catches up like a reconnect
    const offReconnect = onSocketReconnect(() => setSocketEpoch((n) => n + 1))
    const offResolved = onLobbyResolved((data) => {
      if (sameRoom(data.roomName, roomName)) apply({ type: "resolved", sessionId: data.sessionId })
    })
    return () => {
      offRequest()
      offResolved()
      offReconnect()
    }
  }, [enabled, roomName, apply])

  // Every connect replays, so a host who joins late or reconnects still sees who is waiting
  useEffect(() => {
    if (!enabled || !connected) return
    let live = true
    const asked = clock.current
    meetingsAPI
      .lobby(roomName)
      .then((list) => {
        if (!live) return
        setIsHost(true)
        const newer = new Set([...arrived.current].filter(([, at]) => at > asked).map(([sessionId]) => sessionId))
        apply({ type: "replay", entries: list.map((e) => ({ sessionId: e.sessionId, guestName: e.guestName })), newer })
      })
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 403)) console.error("Lobby replay failed:", err)
      })
    return () => {
      live = false
    }
  }, [enabled, connected, socketEpoch, roomName, apply])

  const answer = useCallback(
    async (entry: LobbyEntry, admit: boolean) => {
      setBusy((b) => new Set(b).add(entry.sessionId))
      try {
        await (admit ? meetingsAPI.admitGuest : meetingsAPI.denyGuest)(entry.sessionId, roomName)
        apply({ type: "resolved", sessionId: entry.sessionId })
      } catch (err) {
        // A 404 almost always means another host answered first
        if (err instanceof ApiError && err.status === 404) {
          apply({ type: "resolved", sessionId: entry.sessionId })
        } else {
          console.error("Lobby answer failed:", err)
          toast.error(admit ? `Couldn't admit ${entry.guestName}. Try again.` : `Couldn't deny ${entry.guestName}. Try again.`, {
            toasterId: CALL_TOASTER,
          })
        }
      } finally {
        setBusy((b) => {
          const next = new Set(b)
          next.delete(entry.sessionId)
          return next
        })
      }
    },
    [roomName, apply],
  )

  const answerRef = useRef(answer)
  answerRef.current = answer
  const viewRef = useRef(onView)
  viewRef.current = onView
  const toasted = useRef(new Set<string>())

  // One toast per request, and none while the people panel already shows it
  useEffect(() => {
    const waiting = new Set(entries.map((e) => e.sessionId))
    for (const entry of entries) {
      if (toasted.current.has(entry.sessionId)) continue
      toasted.current.add(entry.sessionId)
      if (quiet) continue
      toast.custom(
        (id) => (
          <LobbyToast
            entry={entry}
            onAdmit={() => answerRef.current(entry, true)}
            onView={() => {
              toast.dismiss(id)
              viewRef.current()
            }}
          />
        ),
        { id: toastId(entry.sessionId), toasterId: CALL_TOASTER, duration: Infinity },
      )
    }
    for (const sessionId of toasted.current) {
      if (waiting.has(sessionId)) continue
      toast.dismiss(toastId(sessionId))
      toasted.current.delete(sessionId)
    }
  }, [entries, quiet])

  useEffect(() => {
    const shown = toasted.current
    return () => {
      for (const sessionId of shown) toast.dismiss(toastId(sessionId))
    }
  }, [])

  return { isHost, entries, busy, answer }
}

/** The people panel's "Waiting to join" rows */
export function LobbyRequests({ lobby }: { lobby: Lobby }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {lobby.entries.map((entry) => {
        const busy = lobby.busy.has(entry.sessionId)
        return (
          <li key={entry.sessionId} className="flex min-h-10 items-center gap-2.5 max-lg:min-h-12">
            <UserAvatar user={guestAvatar(entry.guestName)} size="md" />
            <span className="min-w-0 flex-1 truncate text-ui font-medium text-app-text">{entry.guestName}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void lobby.answer(entry, false)}
              aria-label={`Deny ${entry.guestName}`}
            >
              Deny
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void lobby.answer(entry, true)} aria-label={`Admit ${entry.guestName}`}>
              Admit
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
