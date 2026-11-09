import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useNavigate, useSearchParams } from "react-router"
import { useAuth } from "@/providers/AuthProvider"
import { ApiError } from "@/lib/api/request"
import { meetingsAPI } from "@/lib/api/meetings"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { DisconnectReason } from "livekit-client"
import { CallRoom, type CallMedia } from "@/components/call/CallRoom"
import { EndScreen } from "@/components/call/CallEndScreen"
import { Prejoin } from "@/components/call/Prejoin"
import { rejoinChoices, type JoinChoices } from "@/components/call/devices"
import { endScreen, type EndCopy } from "@/components/call/endScreen"
import type { Presence } from "@/components/call/presence"
import { chatPath } from "@/lib/chatDock"
import { callChat, isMeetingWindow, leaveMeetingWindow, leaveMeetingWindowFor } from "@/lib/meetingWindow"
import { onRoomPresence, onSocketReconnect } from "@/lib/socket"
import { useDocumentTitle } from "@/lib/useDocumentTitle"

type Joined = { token: string; livekitUrl: string | null; title: string }

function PrejoinSkeleton() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading the meeting"
      className="flex min-h-window justify-center bg-background md:items-center md:p-8"
    >
      <div className="grid w-full max-w-6xl content-start gap-6 md:grid-cols-[minmax(0,46rem)_minmax(16rem,22rem)] md:content-center md:items-center md:justify-center md:gap-10">
        <div>
          <Skeleton className="aspect-video w-full rounded-none md:rounded-xl" />
          <div className="mt-3 grid gap-3 max-md:px-4 sm:grid-cols-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        </div>
        <div className="flex flex-col gap-6 max-md:px-4">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-6 w-1/2" />
          </div>
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
    </main>
  )
}

function errorCopy(err: unknown) {
  if (err instanceof ApiError && (err.status === 403 || err.status === 404))
    return "You don't have access to this meeting. Ask the organizer to invite you."
  return "This meeting didn't open. Check your connection and try again."
}

export default function MeetingRoomPage() {
  const params = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const roomId = params.roomId as string
  const [search] = useSearchParams()
  // A call started from a chat leads back to that chat, any other call to the calendar
  const chat = useMemo(() => callChat(search, roomId, user?.id), [search, roomId, user?.id])
  const back = chat ? { label: "Back to chat", path: chatPath(chat) } : { label: "Back to calendar", path: "/calendar" }

  const [title, setTitle] = useState<string | null>(null)
  useDocumentTitle(title || "Meeting")
  const [joined, setJoined] = useState<Joined | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choices, setChoices] = useState<JoinChoices | null>(null)
  const [ended, setEnded] = useState<{ copy: EndCopy; duration?: number } | null>(null)
  const lastMedia = useRef<CallMedia | undefined>(undefined)
  // Null while it loads, undefined when it is unavailable and the row stays hidden
  const [presence, setPresence] = useState<Presence | null | undefined>(null)

  // This first token only checks access and names the call. The call itself gets a fresh short-lived one at Join
  const load = useCallback(() => {
    setError(null)
    meetingsAPI
      .getToken(roomId)
      .then((access) => setTitle(access.title))
      .catch((err) => setError(errorCopy(err)))
  }, [roomId])

  const userId = user?.id
  useEffect(() => {
    if (userId) load()
  }, [userId, load])

  // Who is already in the call, reloaded when the count changes and after a socket drop
  const onPrejoin = title !== null && !choices && !ended
  useEffect(() => {
    if (!onPrejoin) return
    let stopped = false
    const load = (retry = true): Promise<void> =>
      meetingsAPI
        .presence(roomId)
        .then((next) => void (!stopped && setPresence(next)))
        .catch((err) => {
          console.error("Presence failed:", err)
          if (stopped) return
          if (retry) setTimeout(() => !stopped && void load(false), 4000)
          else setPresence(undefined)
        })
    load()
    const offPresence = onRoomPresence((event) => event.roomName.toLowerCase() === roomId.toLowerCase() && void load())
    const offReconnect = onSocketReconnect(() => void load())
    return () => {
      stopped = true
      offPresence()
      offReconnect()
    }
  }, [onPrejoin, roomId])

  const backPath = back.path
  const goBack = useCallback(() => {
    void leaveMeetingWindowFor(backPath, navigate)
  }, [navigate, backPath])

  // Leaving on purpose closes a meeting window, everything else gets a screen that says why
  const handleEnd = useCallback((reason: DisconnectReason | undefined, left: boolean, media: CallMedia, duration?: number) => {
    lastMedia.current = media
    const copy = endScreen(reason, left, false, isMeetingWindow())
    setEnded({ copy: copy.close ? endScreen(reason, left, false) : copy, duration })
    if (copy.close) void leaveMeetingWindow(() => {})
  }, [])

  const join = useCallback(
    async (next: JoinChoices) => {
      let fresh: Joined
      try {
        fresh = await meetingsAPI.getToken(roomId)
      } catch (err) {
        throw new Error(errorCopy(err))
      }
      setJoined(fresh)
      setChoices(next)
    },
    [roomId],
  )

  // Rejoin keeps the last choices and skips the pre-join, with a fresh token
  const rejoin = useCallback(async () => {
    const next = await meetingsAPI.getToken(roomId)
    setChoices((c) => c && rejoinChoices(c, lastMedia.current))
    setJoined(next)
    setEnded(null)
  }, [roomId])

  if (error) {
    return (
      <main className="flex min-h-window items-center justify-center bg-background p-4">
        <div
          role="alert"
          className="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl border border-border bg-card p-6 text-center"
        >
          <h1 className="text-title font-semibold text-foreground">Can't open this meeting</h1>
          <p className="text-body text-muted-foreground">{error}</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate(back.path)}>
              {back.label}
            </Button>
            <Button onClick={load}>Try again</Button>
          </div>
        </div>
      </main>
    )
  }

  if (ended)
    return (
      <EndScreen
        copy={ended.copy}
        title={joined?.title ?? title ?? undefined}
        duration={ended.duration}
        onRejoin={rejoin}
        onBack={goBack}
        backLabel={back.label}
      />
    )

  if (title === null) return <PrejoinSkeleton />

  if (!choices || !joined) {
    return (
      <Prejoin
        title={title}
        presence={presence}
        me={user ? { id: user.id, first_name: user.firstName, last_name: user.lastName, avatar_url: user.avatarUrl } : null}
        onJoin={join}
      />
    )
  }

  return (
    <CallRoom
      key={joined.token}
      token={joined.token}
      title={joined.title}
      roomName={roomId}
      livekitUrl={joined.livekitUrl}
      choices={choices}
      onEnd={handleEnd}
    />
  )
}
