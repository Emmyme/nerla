import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { PresenceCat, type PresenceCatSize } from "@/components/ui/presence-cat"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { deviceTimeZone } from "@/lib/dates"
import { HOVER_CARD_CLOSE_MS, HOVER_CARD_OPEN_MS, HOVER_POINTER_QUERY } from "@/lib/motion"
import { useMediaQuery } from "@/lib/useMediaQuery"
import { PRESENCE_WORD, presenceState, presenceText, type PresenceState } from "@/lib/presence"
import { usePresenceEntry } from "@/lib/presenceStore"
import { useAvatarSrc } from "@/lib/useAvatarSrc"
import { cn, TAP } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"

const ProfileCard = lazy(() => import("@/components/people/ProfileCard").then((m) => ({ default: m.ProfileCard })))

export type AvatarUser = {
  id: string
  first_name?: string | null
  last_name?: string | null
  avatar_url?: string | null
}

const SIZE = {
  xs: "size-[1.25rem] text-micro",
  sm: "size-[1.5rem] text-micro",
  compact: "size-[1.75rem] text-caption",
  md: "size-[2rem] text-ui",
  lg: "size-[3rem] text-lead",
  xl: "size-[4rem] text-title",
  "2xl": "size-[5rem] text-title",
}

type Size = keyof typeof SIZE

// The cat sits on the bottom right edge, a little outside the circle
const CAT_SPOT: Record<Size, string> = {
  xs: "-bottom-[0.125rem] -right-[0.1875rem]",
  sm: "-bottom-[0.125rem] -right-[0.125rem]",
  compact: "-bottom-[0.125rem] -right-[0.125rem]",
  md: "-bottom-[0.125rem] -right-[0.125rem]",
  lg: "-bottom-[0.0625rem] -right-[0.0625rem]",
  xl: "bottom-0 right-0",
  "2xl": "bottom-0 right-0",
}

const TONES = ["bg-app-pistachio text-app-pistachio-ink", "bg-app-sky text-app-sky-ink", "bg-app-lavender text-app-lavender-ink"]

function toneFor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return TONES[Math.abs(hash) % TONES.length]
}

export function avatarName(user: AvatarUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ")
}

export function UserAvatar({
  user,
  size = "sm",
  className,
  profile = false,
  tabIndex,
  single = false,
  src,
  presence,
  catSize,
}: {
  user: AvatarUser | null
  size?: Size
  className?: string
  /** One letter, the first name's, for small discs that overlap in a stack */
  single?: boolean
  /** An image already loaded, such as the user's own avatar as a blob URL. Null shows the initials. */
  src?: string | null
  /**
   * A button that opens the profile card. The signed-in user's own card says "You" and has no actions.
   * `beside` puts the card next to the menu the avatar sits in, rather than over it.
   */
  profile?: boolean | { actions: boolean; beside?: boolean }
  tabIndex?: number
  /** A cat badge with the user's online state. The signed-in user's own shows only with "own", which the sidebar uses. */
  presence?: boolean | "own"
  /** The cat's own size, when it should differ from the avatar's */
  catSize?: PresenceCatSize
}) {
  if (presence && user) {
    return (
      <PresenceAvatar
        user={user}
        size={size}
        catSize={catSize ?? size}
        className={className}
        profile={profile}
        tabIndex={tabIndex}
        single={single}
        src={src}
        own={presence === "own"}
      />
    )
  }
  if (profile && user) {
    return (
      <ProfileAvatar
        user={user}
        size={size}
        className={className}
        actions={profile === true || profile.actions}
        beside={profile !== true && !!profile.beside}
        tabIndex={tabIndex}
        single={single}
      />
    )
  }
  return <AvatarDisc user={user} size={size} className={className} single={single} src={src} />
}

function AvatarDisc({
  user,
  size = "sm",
  className,
  decorative = false,
  single = false,
  src: given,
  label,
}: {
  user: AvatarUser | null
  size?: Size
  className?: string
  decorative?: boolean
  single?: boolean
  src?: string | null
  label?: string
}) {
  // A provider photo loads as is, and avatars stored in Nerla go through the shared fetch that carries the session
  const stored = given === undefined ? (user?.avatar_url ?? null) : null
  const absolute = !!stored && /^https?:\/\//i.test(stored)
  const fetched = useAvatarSrc(stored && !absolute ? stored : null)

  if (!user) {
    return (
      <span
        role="img"
        aria-label="Unassigned"
        title="Unassigned"
        className={cn("inline-block shrink-0 rounded-full border-[0.0625rem] border-dashed border-muted-foreground", SIZE[size], className)}
      />
    )
  }

  const name = avatarName(user)
  const initials =
    (single
      ? (user.first_name?.[0] ?? user.last_name?.[0] ?? "")
      : `${user.first_name?.[0] ?? ""}${user.last_name?.[0] ?? ""}`
    ).toUpperCase() || "?"
  const src = given !== undefined ? (given ?? undefined) : absolute ? (stored ?? undefined) : (fetched ?? undefined)

  return (
    <Avatar
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : (label ?? (name || "Unknown user"))}
      title={decorative ? undefined : name || undefined}
      className={cn(SIZE[size], className)}
    >
      {src && <AvatarImage src={src} alt="" className="object-cover" />}
      <AvatarFallback aria-hidden="true" className={cn("leading-none font-semibold", toneFor(user.id))}>
        {initials}
      </AvatarFallback>
    </Avatar>
  )
}

function ProfileAvatar({
  user,
  size,
  className,
  actions,
  beside,
  tabIndex,
  single,
  src,
  state,
  badge,
  onKeyboardFocus,
}: {
  user: AvatarUser
  size: Size
  className?: string
  actions: boolean
  beside: boolean
  tabIndex?: number
  single: boolean
  src?: string | null
  /** The presence word for the label, with the badge inside the button */
  state?: string
  badge?: ReactNode
  onKeyboardFocus?: (focused: boolean) => void
}) {
  const { user: me } = useAuth()
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  // Opened by resting the pointer on it, so it closes again when the pointer leaves
  const [hovered, setHovered] = useState(false)
  const canHover = useMediaQuery(HOVER_POINTER_QUERY, false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const close = useCallback(() => {
    clearTimeout(timer.current)
    setOpen(false)
    setHovered(false)
  }, [])
  const later = (run: () => void, ms: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(run, ms)
  }
  const openByHover = () => {
    clearTimeout(timer.current)
    setHovered(true)
    setOpen(true)
  }
  const leave = () => {
    if (hovered) later(close, HOVER_CARD_CLOSE_MS)
    else clearTimeout(timer.current)
  }

  useEffect(() => () => clearTimeout(timer.current), [])
  // One card at a time, so opening another closes this one
  useEffect(() => {
    if (!open) return
    const mine: OpenCard = { close, hovered }
    if (openCard && openCard.close !== close) openCard.close()
    openCard = mine
    return () => {
      if (openCard === mine) openCard = null
    }
  }, [open, hovered, close])

  if (!me) return <AvatarDisc user={user} size={size} className={className} single={single} src={src} />

  const name = avatarName(user) || "Unknown user"
  return (
    <>
      <button
        ref={button}
        type="button"
        tabIndex={tabIndex}
        aria-label={state ? `Open ${name}'s profile, ${state.toLowerCase()}` : `Open ${name}'s profile`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={badge ? undefined : name}
        onPointerEnter={(event) => {
          if (!canHover || event.pointerType !== "mouse") return
          if (open) return clearTimeout(timer.current)
          // Moving along a list while a card is up swaps it straight away, with no gap between cards
          if (openCard?.hovered) openByHover()
          else later(openByHover, HOVER_CARD_OPEN_MS)
        }}
        onPointerLeave={leave}
        onClick={() => {
          onKeyboardFocus?.(false)
          clearTimeout(timer.current)
          if (open && hovered) return setHovered(false)
          setHovered(false)
          setOpen(!open)
        }}
        onFocus={(event) => {
          if (onKeyboardFocus && focusVisible(event.currentTarget)) onKeyboardFocus(true)
        }}
        onBlur={() => onKeyboardFocus?.(false)}
        className={cn(
          "relative inline-flex shrink-0 cursor-pointer rounded-full transition-[filter] duration-150 hover:brightness-95 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
          TAP,
          // The smallest disc still gets a 1.5rem target, without moving the layout around it
          size === "xs" && "-m-0.5 p-0.5",
          className,
        )}
      >
        <span title={badge ? name : undefined} className="flex">
          <AvatarDisc user={user} size={size} decorative single={single} src={src} />
        </span>
        {badge}
      </button>
      {open && (
        <Suspense fallback={null}>
          <ProfileCard
            userId={user.id}
            user={user}
            anchor={(beside && button.current?.closest<HTMLElement>('[role="dialog"]')) || button.current}
            side={beside ? "right" : "bottom"}
            actions={actions}
            onClose={close}
            returnFocus={() => button.current?.focus()}
            hover={hovered}
            onPointerEnter={() => clearTimeout(timer.current)}
            onPointerLeave={leave}
          />
        </Suspense>
      )}
    </>
  )
}

type OpenCard = { close: () => void; hovered: boolean }
let openCard: OpenCard | null = null

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible")
  } catch {
    return false
  }
}

function PresenceBadge({
  state,
  text,
  size,
  catSize,
  focusable,
  open,
  onOpenChange,
}: {
  state: PresenceState
  text: string
  size: Size
  catSize: PresenceCatSize
  focusable: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const touch = useRef(false)
  const wasOpen = useRef(false)
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip open={open} onOpenChange={onOpenChange}>
        <TooltipTrigger asChild>
          <span
            role={focusable ? "img" : undefined}
            aria-label={focusable ? text.split("\n").join(", ") : undefined}
            aria-hidden={focusable ? undefined : true}
            tabIndex={focusable ? 0 : undefined}
            data-presence={state}
            // A tap shows the text and does nothing else, since a touch screen has no hover
            onPointerDown={(event) => {
              touch.current = event.pointerType !== "mouse"
              if (!touch.current) return
              wasOpen.current = open
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              if (!touch.current) return
              event.preventDefault()
              event.stopPropagation()
              onOpenChange(!wasOpen.current)
            }}
            className={cn(
              "absolute z-[1] flex rounded-full focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
              CAT_SPOT[size],
            )}
          >
            <PresenceCat state={state} size={catSize} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[16rem] whitespace-pre-line">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function PresenceAvatar({
  user,
  size,
  catSize,
  className,
  profile,
  tabIndex,
  single,
  src,
  own,
}: {
  user: AvatarUser
  size: Size
  catSize: PresenceCatSize
  className?: string
  profile?: boolean | { actions: boolean; beside?: boolean }
  tabIndex?: number
  single: boolean
  src?: string | null
  own: boolean
}) {
  const { user: me } = useAuth()
  const self = !!me && me.id.toLowerCase() === user.id.toLowerCase()
  const entry = usePresenceEntry(me && (own || !self) ? user.id : null, own)
  const [tip, setTip] = useState(false)
  const wrapper = useRef<HTMLSpanElement>(null)
  // Inside a row or a menu button the cat is no tab stop of its own
  const [nested, setNested] = useState(true)
  useEffect(() => {
    setNested(!!wrapper.current?.parentElement?.closest("button, a, [role=button], [role=menuitem], [role=option]"))
  }, [])

  const now = new Date()
  const state = entry ? presenceState(entry, now) : null
  const badge = (focusable: boolean) =>
    entry && state ? (
      <PresenceBadge
        state={state}
        text={presenceText(entry, now, deviceTimeZone())}
        size={size}
        catSize={catSize}
        focusable={focusable}
        open={tip}
        onOpenChange={setTip}
      />
    ) : null

  if (profile) {
    return (
      <ProfileAvatar
        user={user}
        size={size}
        className={className}
        actions={profile === true || profile.actions}
        beside={profile !== true && !!profile.beside}
        tabIndex={tabIndex}
        single={single}
        src={src}
        state={state ? PRESENCE_WORD[state] : undefined}
        badge={badge(false)}
        onKeyboardFocus={setTip}
      />
    )
  }
  const name = avatarName(user) || "Unknown user"
  return (
    <span ref={wrapper} className={cn("relative inline-flex shrink-0 rounded-full", className)}>
      <AvatarDisc
        user={user}
        size={size}
        single={single}
        src={src}
        label={state ? `${name}, ${PRESENCE_WORD[state].toLowerCase()}` : undefined}
      />
      {badge(!nested)}
    </span>
  )
}

/** The avatar of a user the server names in one string, as on grants and storage rows */
export function avatarOf(person: { id: string; name: string; avatarUrl: string | null }): AvatarUser {
  const [first, ...rest] = person.name.split(" ")
  return { id: person.id, first_name: first, last_name: rest.join(" ") || null, avatar_url: person.avatarUrl }
}
