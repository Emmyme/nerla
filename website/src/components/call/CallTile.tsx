import {
  ParticipantTile,
  VideoTrack,
  isTrackReference,
  useIsMuted,
  useIsSpeaking,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react"
import { memo, useEffect, useRef, useState, type CSSProperties } from "react"
import { Track, type Participant } from "livekit-client"
import { MicrophoneSlash, Pin, PinOff } from "@/components/icons"
import { UserAvatar } from "@/components/ui/user-avatar"
import { cn } from "@/lib/utils"
import { avatarOf } from "./avatar"
import { CallIconButton } from "./CallIconButton"
import { SpeakingBars, useLevelVar } from "./SpeakingLevel"

export function whoIs(p: Participant): { name: string; guest: boolean } {
  let role: unknown
  try {
    role = p.metadata ? (JSON.parse(p.metadata) as { role?: unknown }).role : undefined
  } catch {
    role = undefined
  }
  const guest = role === "guest" || p.identity.startsWith("guest-")
  const raw = (p.name || p.identity).trim()
  return { name: guest ? raw.replace(/\s*\(guest\)$/i, "") : raw, guest }
}

export function tileKey(ref: TrackReferenceOrPlaceholder) {
  return `${ref.participant.identity}:${ref.source === Track.Source.ScreenShare ? "screen" : "camera"}`
}

type TileProps = {
  tileId: string
  trackRef: TrackReferenceOrPlaceholder
  pinned: boolean
  /** Without it the tile has no pin button, as in the mini call */
  onPin?: (key: string) => void
  className?: string
  style?: CSSProperties
}

function sameTile(a: TileProps, b: TileProps) {
  return (
    a.tileId === b.tileId &&
    a.trackRef.participant === b.trackRef.participant &&
    a.trackRef.publication === b.trackRef.publication &&
    a.pinned === b.pinned &&
    a.onPin === b.onPin &&
    a.className === b.className &&
    a.style?.width === b.style?.width
  )
}

export const CallTile = memo(function CallTile({ tileId, trackRef, pinned, onPin, className, style }: TileProps) {
  const p = trackRef.participant
  const screen = trackRef.source === Track.Source.ScreenShare
  const videoOff = useIsMuted(trackRef)
  const micOff = useIsMuted({ participant: p, source: Track.Source.Microphone })
  const speaking = useIsSpeaking(p) && !screen && !micOff
  const root = useRef<HTMLDivElement>(null)
  useLevelVar(root, p, speaking)
  const { name, guest } = whoIs(p)
  const showVideo = isTrackReference(trackRef) && !videoOff
  const label = screen ? (p.isLocal ? "Your screen" : `${name}'s screen`) : p.isLocal ? `${name} (you)` : name
  const pinLabel = pinned ? `Unpin ${label}` : `Pin ${label}`

  // Touch has no hover, so a tap shows the pin button for a moment
  const [tapped, setTapped] = useState(0)
  useEffect(() => {
    if (!tapped) return
    const timer = setTimeout(() => setTapped(0), 4000)
    return () => clearTimeout(timer)
  }, [tapped])

  return (
    <ParticipantTile
      ref={root}
      trackRef={trackRef}
      data-tile={tileId}
      disableSpeakingIndicator
      aria-label={label}
      role="group"
      style={style}
      onPointerUp={(e) => {
        if (onPin && e.pointerType !== "mouse") setTapped(Date.now())
      }}
      className={cn("group @container relative overflow-hidden rounded-lg", screen ? "bg-app-bg" : "bg-app-sunk", className)}
    >
      {showVideo ? (
        <VideoTrack
          trackRef={trackRef}
          className={cn("size-full", screen ? "object-contain" : "object-cover", p.isLocal && !screen && "-scale-x-100")}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="relative inline-flex">
            {speaking && (
              <>
                <span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full bg-app-pistachio transition-transform duration-100 ease-out"
                  style={{ transform: "scale(calc(1.1 + var(--level, 0.5) * 0.22))" }}
                />
                <span aria-hidden="true" className="absolute inset-0 scale-105 rounded-full bg-app-sunk" />
              </>
            )}
            <UserAvatar
              user={avatarOf(p.identity, name)}
              size="md"
              className="relative size-12 text-body @3xs:size-16 @3xs:text-title @sm:size-24"
            />
          </span>
        </div>
      )}

      {speaking && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[inherit] ring-[0.1875rem] ring-app-pistachio ring-inset"
        />
      )}

      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-app-bg/75 px-2 py-0.5 text-caption font-medium text-app-text">
        {micOff && !screen && (
          <>
            <MicrophoneSlash aria-hidden="true" className="size-3.5 shrink-0 text-app-berry-text" />
            <span className="sr-only">Microphone off,</span>
          </>
        )}
        {speaking && <SpeakingBars />}
        {p.isLocal && !screen ? (
          <>
            <span aria-hidden="true" className="@3xs:hidden">
              You
            </span>
            <span className="truncate @max-3xs:sr-only">{label}</span>
          </>
        ) : (
          <span className="truncate">{label}</span>
        )}
        {guest && !screen && (
          <span className="shrink-0 rounded-full bg-app-lavender px-1.5 text-micro font-medium text-app-lavender-ink">Guest</span>
        )}
      </div>

      {onPin && (
        <CallIconButton
          label={pinLabel}
          side="bottom"
          onClick={() => onPin(tileId)}
          className={cn(
            "absolute top-2 right-2 size-8 bg-app-bg/75 hover:bg-app-bg max-lg:size-11 [&_svg]:size-4",
            pinned || tapped
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
          )}
        >
          {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
        </CallIconButton>
      )}
    </ParticipantTile>
  )
}, sameTile)
