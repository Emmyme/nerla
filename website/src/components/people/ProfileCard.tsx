import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"
import { IconTip } from "@/components/ui/icon-tip"
import { Check, Clock, Copy, Mail, MapPin, MessageCircle, Pencil, Phone, ShieldCheck, Video, type IconComponent } from "@/components/icons"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { AnchoredPopover, type PopoverSide, type VirtualAnchor } from "@/components/ui/anchored-popover"
import { BottomSheet } from "@/components/ui/bottom-sheet"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { avatarName, UserAvatar, type AvatarUser } from "@/components/ui/user-avatar"
import { chatsAPI, type ChatSummary } from "@/lib/api/chat"
import type { UserProfile } from "@/lib/api/users"
import { openChat } from "@/lib/chatDock"
import { chatKey } from "@/lib/chatModel"
import { useChats } from "@/lib/chatHooks"
import { deviceTimeZone, formatTime, formatZoneDifference, wallTimeIn } from "@/lib/dates"
import { openMeetingWindow } from "@/lib/meetingWindow"
import { useProfile } from "@/lib/profiles"
import { messageOf } from "@/lib/taskStore"
import { useCopied } from "@/lib/useCopied"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"

const CALL_FAILED = "Couldn't start the call. Check your connection and try again."
const ROW_ICON = "size-[1rem] shrink-0 text-muted-foreground"
const SMALL_ICON =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring max-lg:size-11"

/** Copies a value, with a check for two seconds and a spoken confirmation */
function useCopy(value: string, failed: string) {
  const [copied, markCopied] = useCopied()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      markCopied()
    } catch {
      toast.error(failed)
    }
  }
  return { copied, copy }
}

function CopyButton({ value, what, className }: { value: string; what: "email" | "phone number"; className?: string }) {
  const { copied, copy } = useCopy(value, `Couldn't copy the ${what}. Try again.`)
  const label = `Copy ${what}`
  return (
    <>
      <IconTip label={copied ? "Copied" : label}>
        <button type="button" onClick={() => void copy()} aria-label={label} className={cn(SMALL_ICON, className)}>
          {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
        </button>
      </IconTip>
      <span role="status" className="sr-only">
        {copied ? `${what === "email" ? "Email" : "Phone number"} copied` : ""}
      </span>
    </>
  )
}

function InfoRow({ icon: Icon, label, children, action }: { icon: IconComponent; label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex min-h-6 min-w-0 items-center gap-2.5 max-lg:min-h-11">
      <Icon aria-hidden="true" className={ROW_ICON} />
      <span className="sr-only">{label}: </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {action}
    </li>
  )
}

/** Their local time, kept current while the card is open */
function LocalTime({ zone }: { zone: string }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const difference = formatZoneDifference(now, zone, deviceTimeZone())
  return (
    <>
      {formatTime(wallTimeIn(now, zone))} local time
      {difference && <span className="text-muted-foreground"> ({difference})</span>}
    </>
  )
}

function InfoRows({ profile }: { profile: UserProfile }) {
  return (
    <ul className="mt-4 flex flex-col gap-1.5 text-ui text-foreground">
      {profile.time_zone && (
        <InfoRow icon={Clock} label="Local time">
          <span title={profile.time_zone.replace(/_/g, " ")}>
            <LocalTime zone={profile.time_zone} />
          </span>
        </InfoRow>
      )}
      {profile.location && (
        <InfoRow icon={MapPin} label="Location">
          <span title={profile.location}>{profile.location}</span>
        </InfoRow>
      )}
      <InfoRow icon={Mail} label="Email" action={<CopyButton value={profile.email} what="email" />}>
        <span title={profile.email}>{profile.email}</span>
      </InfoRow>
      {profile.phone && (
        <InfoRow icon={Phone} label="Phone" action={<CopyButton value={profile.phone} what="phone number" />}>
          <span title={profile.phone}>{profile.phone}</span>
        </InfoRow>
      )}
    </ul>
  )
}

// Focus starts on the card itself, so no tooltip opens with it
const focusCard = (event: Event) => {
  event.preventDefault()
  ;(event.currentTarget as HTMLElement | null)?.focus()
}

function Actions({
  userId,
  person,
  name,
  self,
  onDone,
}: {
  userId: string
  person: AvatarUser
  name: string
  self: boolean
  onDone: (docked: boolean) => void
}) {
  const navigate = useNavigate()
  const { chats } = useChats()
  const id = userId.toLowerCase()
  const message = () => {
    const key = chatKey("dm", id)
    const listed = chats.find((chat) => chatKey(chat.kind, chat.id) === key)
    const chat: ChatSummary = listed ?? {
      kind: "dm",
      id,
      title: name,
      project_id: null,
      members: [{ id, first_name: person.first_name ?? null, last_name: person.last_name ?? null, avatar_url: person.avatar_url ?? null }],
      member_count: 2,
      can_pin: true,
      last_message: null,
      last_activity_at: "",
      unread: false,
    }
    onDone(openChat(chat, navigate))
  }

  const call = async () => {
    onDone(false)
    try {
      const { roomName } = await chatsAPI.call("dm", id)
      await openMeetingWindow(roomName, { chat: { kind: "dm", id } })
    } catch (err) {
      toast.error(messageOf(err, CALL_FAILED))
    }
  }

  return (
    <div className="mt-4 flex items-center gap-2 border-t-[0.0625rem] border-border pt-3">
      {self ? (
        <IconTip label="Edit profile">
          <Button asChild variant="secondary" size="icon" aria-label="Edit profile">
            <Link to="/settings/profile" onClick={() => onDone(false)}>
              <Pencil aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </IconTip>
      ) : (
        <>
          <IconTip label={`Message ${name}`}>
            <Button type="button" variant="bubble" size="icon" aria-label={`Message ${name}`} onClick={message}>
              <MessageCircle aria-hidden="true" weight="fill" className="size-4" />
            </Button>
          </IconTip>
          <IconTip label={`Call ${name}`}>
            <Button type="button" variant="join" size="icon" aria-label={`Call ${name}`} onClick={() => void call()}>
              <Video aria-hidden="true" weight="fill" className="size-4" />
            </Button>
          </IconTip>
        </>
      )}
    </div>
  )
}

function AdminMark() {
  return (
    <IconTip label="Workspace admin">
      <span
        tabIndex={0}
        className="inline-flex shrink-0 rounded-sm text-muted-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
      >
        <ShieldCheck aria-hidden="true" weight="fill" className="size-[1rem]" />
        <span className="sr-only">Workspace admin</span>
      </span>
    </IconTip>
  )
}

/**
 * A user's card, opened from their avatar: who they are first, then how to reach them, then icon actions.
 * In a call there is nowhere to go, so the card has no actions.
 */
export function ProfileCard({
  userId,
  user,
  anchor,
  side = "bottom",
  actions = true,
  onClose,
  returnFocus,
  hover = false,
  onPointerEnter,
  onPointerLeave,
}: {
  userId: string
  /** What the avatar already knows, shown while the card loads */
  user?: AvatarUser
  anchor: VirtualAnchor | null
  side?: PopoverSide
  actions?: boolean
  onClose: () => void
  returnFocus?: () => void
  /** Opened by a hover, so it leaves focus where it is */
  hover?: boolean
  onPointerEnter?: () => void
  onPointerLeave?: () => void
}) {
  const { user: me } = useAuth()
  const [attempt, setAttempt] = useState(0)
  const state = useProfile(me?.id ?? "", userId, attempt)
  const skipReturn = useRef(false)
  const self = !!me && me.id.toLowerCase() === userId.toLowerCase()
  const desktop = useIsDesktop()
  // The phone sheet closes itself first, so it can slide away before the card unmounts
  const [sheetOpen, setSheetOpen] = useState(true)

  const profile = state.status === "ready" ? state.profile : null
  const person: AvatarUser = profile ?? user ?? { id: userId }
  const name = avatarName(person) || profile?.email || "Unknown user"
  const subline = profile ? [profile.team, profile.pronouns].filter(Boolean).join(" · ") : ""

  const done = (docked: boolean) => {
    // A chat opened in the dock takes focus itself
    skipReturn.current = docked
    onClose()
  }

  const content = (
    <>
      <div className="flex min-w-0 items-center gap-3">
        <UserAvatar user={person} size="xl" presence />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-lead font-semibold text-foreground" title={name}>
              {name}
            </p>
            {profile?.role === "admin" && <AdminMark />}
          </div>
          {state.status === "loading" ? (
            <Skeleton className="h-3 w-28" />
          ) : profile ? (
            <>
              {profile.job_title && <p className="truncate text-ui text-foreground">{profile.job_title}</p>}
              {subline && <p className="truncate text-caption text-muted-foreground">{subline}</p>}
              {self && !profile.job_title && !subline && <p className="text-caption text-muted-foreground">You</p>}
            </>
          ) : state.status === "missing" ? (
            <p className="text-caption text-muted-foreground">Not in your workspace</p>
          ) : (
            self && <p className="text-caption text-muted-foreground">You</p>
          )}
        </div>
      </div>

      {state.status === "loading" ? (
        <div aria-hidden="true" className="mt-4 flex flex-col gap-2.5">
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-3 w-44" />
        </div>
      ) : profile ? (
        <InfoRows profile={profile} />
      ) : state.status === "error" ? (
        <p role="alert" className="mt-3 flex items-center gap-2 text-caption text-muted-foreground">
          Couldn't load their details.
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
          >
            Try again
          </button>
        </p>
      ) : null}

      {actions && state.status !== "missing" && <Actions userId={userId} person={person} name={name} self={self} onDone={done} />}
    </>
  )

  const back = () => {
    if (!skipReturn.current && !hover) returnFocus?.()
  }

  // A phone has no room beside the avatar, so the card rises from the bottom edge
  if (!desktop) {
    return (
      <BottomSheet
        open={sheetOpen}
        onOpenChange={(next) => !next && setSheetOpen(false)}
        title={name}
        returnFocus={() => {
          back()
          onClose()
        }}
        onOpenAutoFocus={focusCard}
        className="px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        {content}
      </BottomSheet>
    )
  }

  return (
    <AnchoredPopover
      open
      onOpenChange={(next) => !next && onClose()}
      anchor={anchor}
      side={side}
      title={name}
      className="w-80 p-4"
      returnFocus={back}
      onOpenAutoFocus={hover ? (event) => event.preventDefault() : focusCard}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      keepOnAnchorPress
    >
      {content}
    </AnchoredPopover>
  )
}
