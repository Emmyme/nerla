import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { useMatch } from "react-router"
import { toast } from "sonner"
import { Video } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/ui/user-avatar"
import { claimForWindow, openMeetingWindow, sameRoom } from "@/lib/meetingWindow"
import { notify } from "@/lib/notify"
import { doNotDisturb, useOwnStatus } from "@/lib/presenceStore"
import { emitMeetingInviteDeclined, onMeetingInvite, onMeetingInviteDeclined } from "@/lib/socket"
import { remPx } from "@/lib/utils"
import { avatarOf } from "./avatar"
import { CALL_TOAST_SURFACE, CALL_TOASTER, INVITE_TTL, inviteLine, isDmRoom, queueInvite, type Invite } from "./incoming"

const CHANNEL = "nerla-incoming-calls"

// On a call stage the note joins the stage's own dark notices
function say(text: string) {
  if (!document.querySelector("[data-call-stage]")) return void toast(text)
  toast.custom(
    () => (
      <div className={CALL_TOAST_SURFACE}>
        <p className="text-ui font-medium">{text}</p>
      </div>
    ),
    { toasterId: CALL_TOASTER },
  )
}

function IncomingCard({ invite, onJoin, onDecline }: { invite: Invite; onJoin: () => void; onDecline: () => void }) {
  const line = inviteLine(invite)
  const dm = isDmRoom(invite.roomName)
  // Do not disturb keeps the card but drops the ringing pulse
  const quiet = useOwnStatus()?.value === "dnd"
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return
    e.stopPropagation()
    onDecline()
  }
  return (
    <div
      role="group"
      aria-label={line}
      onKeyDown={onKeyDown}
      className="pointer-events-auto rounded-lg border border-border bg-card p-3 text-foreground shadow-[var(--shadow-popover)]"
    >
      <div className="flex items-start gap-3">
        <span className="relative mt-0.5 shrink-0">
          {!quiet && (
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-full bg-app-pistachio motion-safe:animate-[ping_1s_cubic-bezier(0,0,0.2,1)_3]"
            />
          )}
          <UserAvatar user={avatarOf(invite.callerId, invite.callerName)} size="md" className="relative ring-2 ring-app-pistachio" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ui font-medium break-words">
            <span className="font-semibold">{invite.callerName}</span>
            {line.slice(invite.callerName.length)}
          </p>
          <p className="mt-0.5 text-caption text-muted-foreground">{dm ? "Video call" : "Video meeting"}</p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onDecline}>
          Decline
        </Button>
        <Button size="sm" variant="join" onClick={onJoin}>
          <Video aria-hidden="true" className="size-3.5" />
          Join
        </Button>
      </div>
    </div>
  )
}

function isQuiet(quiet: Map<string, number>, roomName: string): boolean {
  const key = roomName.toLowerCase()
  const until = quiet.get(key) ?? 0
  if (until <= Date.now()) quiet.delete(key)
  return until > Date.now()
}

type Message = { answered?: string; here?: string; left?: string }

const ANSWERED_TTL = 3000
const HERE_TTL = 12_000
const HEARTBEAT = 5000

/**
 * Calls and meeting invites, newest on top. No window rings for a room the user already has open in a meeting window.
 * The stack's height moves the app's toasts below it.
 */
export function IncomingCalls({ onHeight }: { onHeight?: (rem: number) => void }) {
  const [invites, setInvites] = useState<Invite[]>([])
  const [announced, setAnnounced] = useState("")
  const here = useMatch("/meeting-room/:roomId")?.params.roomId
  const hereRef = useRef(here)
  const channel = useRef<BroadcastChannel | null>(null)
  // Rooms answered in another window a moment ago, or open in a meeting window, mapped to when that lapses
  const quiet = useRef(new Map<string, number>())

  const drop = useCallback(
    (roomName: string) =>
      setInvites((q) => (q.some((i) => sameRoom(i.roomName, roomName)) ? q.filter((i) => !sameRoom(i.roomName, roomName)) : q)),
    [],
  )
  const hush = useCallback(
    (roomName: string, ttl: number) => {
      quiet.current.set(roomName.toLowerCase(), Date.now() + ttl)
      drop(roomName)
    },
    [drop],
  )

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return
    const bc = new BroadcastChannel(CHANNEL)
    bc.onmessage = (e: MessageEvent<Message>) => {
      const { answered, here: open, left } = e.data ?? {}
      if (answered) hush(answered, ANSWERED_TTL)
      if (open) hush(open, HERE_TTL)
      if (left) quiet.current.delete(left.toLowerCase())
    }
    channel.current = bc
    return () => {
      bc.close()
      channel.current = null
    }
  }, [hush])

  // A meeting window drops cards for its own room and keeps telling the other windows it is there
  useEffect(() => {
    hereRef.current = here
    if (!here) return
    drop(here)
    const bc = channel.current
    const post = (message: Message) => {
      try {
        bc?.postMessage(message)
      } catch {
        return
      }
    }
    post({ here })
    const timer = setInterval(() => post({ here }), HEARTBEAT)
    const leave = () => post({ left: here })
    window.addEventListener("pagehide", leave)
    return () => {
      clearInterval(timer)
      window.removeEventListener("pagehide", leave)
      leave()
    }
  }, [here, drop])

  useEffect(() => {
    const offInvite = onMeetingInvite((data) => {
      const room = hereRef.current
      if ((room && sameRoom(room, data.roomName)) || isQuiet(quiet.current, data.roomName)) return
      const invite: Invite = {
        roomName: data.roomName,
        callerId: data.callerId,
        callerName: data.callerName?.trim() || "Someone",
        title: data.title ?? "",
        at: Date.now(),
        chat: data.chat && (data.chat.kind === "dm" || data.chat.kind === "group") && typeof data.chat.id === "string" ? data.chat : null,
      }
      setInvites((q) => queueInvite(q, invite, invite.at))
      setAnnounced(inviteLine(invite))
      const hidden = document.visibilityState === "hidden"
      void claimForWindow(`ring:${data.roomName}:${data.callerId}`).then((mine) => {
        if (mine && hidden && document.visibilityState === "hidden") void notify(inviteLine(invite), { tag: `call-${data.roomName}` })
      })
    })
    const offDeclined = onMeetingInviteDeclined((data) => {
      const room = hereRef.current
      if (room && !sameRoom(room, data.roomName)) return
      void claimForWindow(`declined:${data.userId}:${data.roomName}`, { preferred: !!room }).then((mine) => {
        if (mine) say(`${data.name} declined`)
      })
    })
    return () => {
      offInvite()
      offDeclined()
    }
  }, [])

  // A card that times out turns into a missed call toast
  useEffect(() => {
    if (invites.length === 0) {
      setAnnounced("")
      return
    }
    const next = Math.min(...invites.map((i) => i.at)) + INVITE_TTL
    const timer = setTimeout(
      () => {
        const now = Date.now()
        const expired = invites.filter((i) => now - i.at >= INVITE_TTL)
        setInvites((q) => q.filter((i) => now - i.at < INVITE_TTL))
        for (const i of doNotDisturb() ? [] : expired) {
          void claimForWindow(`missed:${i.roomName}:${i.callerId}`).then((mine) => {
            if (mine) say(`Missed call from ${i.callerName}`)
          })
        }
      },
      Math.max(0, next - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [invites])

  const answer = (invite: Invite, join: boolean) => {
    drop(invite.roomName)
    channel.current?.postMessage({ answered: invite.roomName } satisfies Message)
    if (join) void openMeetingWindow(invite.roomName, { chat: invite.chat })
    else emitMeetingInviteDeclined(invite.callerId, invite.roomName)
  }

  const region = useRef<HTMLElement>(null)
  const ringing = invites.length > 0
  useLayoutEffect(() => {
    if (!onHeight) return
    const el = region.current
    if (!el) return onHeight(0)
    const report = () => {
      const root = remPx()
      onHeight(el.offsetHeight / root)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [onHeight, ringing])

  return (
    <>
      <p aria-live="polite" className="sr-only">
        {announced}
      </p>
      {ringing && (
        <section
          ref={region}
          data-incoming-calls=""
          aria-label="Incoming calls"
          className="pointer-events-none fixed top-below-titlebar right-4 z-60 flex w-88 flex-col gap-2 max-sm:left-4 max-sm:w-auto"
        >
          {invites.map((invite) => (
            <IncomingCard
              key={invite.roomName.toLowerCase()}
              invite={invite}
              onJoin={() => answer(invite, true)}
              onDecline={() => answer(invite, false)}
            />
          ))}
        </section>
      )}
    </>
  )
}
