import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react"
import {
  useAudioPlayback,
  useConnectionState,
  useLocalParticipant,
  useSpeakingParticipants,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react"
import { ConnectionState, RoomEvent, Track } from "livekit-client"
import { toast } from "sonner"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { ChevronLeft, ChevronRight, Screencast } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { LoadingSpinner, Spinner } from "@/components/ui/spinner"
import { cn, remPx } from "@/lib/utils"
import { CallIconButton } from "./CallIconButton"
import { CallTile, tileKey } from "./CallTile"
import { CALL_TOASTER } from "./incoming"
import { fillGrid, fitTiles, pageSize, stageLayout, type StageMode, type StageTile } from "./stage"

const GAP_REM = 0.5

// Mute, speaking and subscription changes are handled inside each tile
const TILE_EVENTS = [
  RoomEvent.ConnectionStateChanged,
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
]

function useBoxSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () =>
      setSize((s) => (s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}

export function useStageTiles() {
  const refs = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false, updateOnlyOn: TILE_EVENTS },
  )
  const seen = useRef(new Map<string, number>())
  const counter = useRef(0)
  return useMemo(() => {
    const byKey = new Map<string, TrackReferenceOrPlaceholder>()
    const tiles: StageTile[] = []
    for (const ref of refs) {
      const key = tileKey(ref)
      if (byKey.has(key)) continue
      if (!seen.current.has(key)) seen.current.set(key, ++counter.current)
      byKey.set(key, ref)
      tiles.push({
        key,
        participant: ref.participant.identity,
        source: ref.source === Track.Source.ScreenShare ? "screen" : "camera",
        publishedAt: seen.current.get(key)!,
        local: ref.participant.isLocal,
      })
    }
    for (const key of [...seen.current.keys()]) if (!byKey.has(key)) seen.current.delete(key)
    return { tiles, byKey }
  }, [refs])
}

/** Mounted only when the active speaker is needed, so the grid never re-renders on speaking changes. It keeps the last remote participant who spoke */
export function SpeakerTracker({ onChange }: { onChange: (identity: string) => void }) {
  const speakers = useSpeakingParticipants()
  useEffect(() => {
    const next = speakers.find((p) => !p.isLocal)
    if (next) onChange(next.identity)
  }, [speakers, onChange])
  return null
}

type Shared = {
  byKey: Map<string, TrackReferenceOrPlaceholder>
  pinned?: string
  onPin: (key: string) => void
  phone: boolean
}

function Pager({ current, pages, onPage }: { current: number; pages: number; onPage: (page: number) => void }) {
  return (
    <div className="flex shrink-0 items-center justify-center gap-2">
      <CallIconButton
        label="Previous page"
        disabled={current === 0}
        onClick={() => onPage(current - 1)}
        className="size-8 max-lg:size-11 [&_svg]:size-4"
      >
        <ChevronLeft aria-hidden="true" />
      </CallIconButton>
      <span className="text-caption text-app-text-muted tabular-nums">
        {current + 1} of {pages}
      </span>
      <CallIconButton
        label="Next page"
        disabled={current === pages - 1}
        onClick={() => onPage(current + 1)}
        className="size-8 max-lg:size-11 [&_svg]:size-4"
      >
        <ChevronRight aria-hidden="true" />
      </CallIconButton>
    </div>
  )
}

function Grid({ tiles, byKey, pinned, onPin, phone }: Shared & { tiles: StageTile[] }) {
  const box = useRef<HTMLDivElement>(null)
  const { width, height } = useBoxSize(box)
  const rem = remPx()
  const per = pageSize(tiles.length, phone || width < 40 * rem)
  const pages = Math.max(1, Math.ceil(tiles.length / per))
  const [page, setPage] = useState(0)
  const current = Math.min(page, pages - 1)
  const swipe = useRef<{ x: number; y: number } | null>(null)

  const swipeProps = {
    onPointerDown: (e: PointerEvent) => {
      swipe.current = e.pointerType === "touch" && pages > 1 ? { x: e.clientX, y: e.clientY } : null
    },
    onPointerUp: (e: PointerEvent) => {
      const start = swipe.current
      swipe.current = null
      if (!start) return
      const dx = e.clientX - start.x
      if (Math.abs(dx) < 3 * rem || Math.abs(dx) < Math.abs(e.clientY - start.y)) return
      setPage(Math.min(pages - 1, Math.max(0, current + (dx < 0 ? 1 : -1))))
    },
    onPointerCancel: () => {
      swipe.current = null
    },
  }
  const shown = tiles.slice(current * per, current * per + per)
  const pager = pages > 1 && <Pager current={current} pages={pages} onPage={setPage} />

  // Phones fill the stage, so each tile crops its video to its cell
  if (phone) {
    const { cols, rows } = fillGrid(shown.length)
    return (
      <div {...swipeProps} className={cn("flex size-full flex-col gap-1 p-1", pages > 1 && "touch-pan-y")}>
        <div
          className="grid min-h-0 flex-1 gap-1"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
        >
          {shown.map((t, i) => (
            <CallTile
              key={t.key}
              tileId={t.key}
              trackRef={byKey.get(t.key)!}
              pinned={pinned === t.key}
              onPin={onPin}
              className={cn("size-full min-h-0", cols === 2 && shown.length % 2 === 1 && i === shown.length - 1 && "col-span-2")}
            />
          ))}
        </div>
        {pager}
      </div>
    )
  }

  const pagerHeight = pages > 1 ? 3 * rem : 0
  const gap = GAP_REM * rem
  const { cols, tileWidth } = fitTiles(shown.length, width, height - pagerHeight, gap)
  const rowWidth = cols * tileWidth + (cols - 1) * gap

  return (
    <div ref={box} {...swipeProps} className={cn("relative size-full", pages > 1 && "touch-pan-y")}>
      {tileWidth > 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <div className="flex flex-wrap content-center justify-center gap-2" style={{ width: `${rowWidth / rem}rem` }}>
            {shown.map((t) => (
              <CallTile
                key={t.key}
                tileId={t.key}
                trackRef={byKey.get(t.key)!}
                pinned={pinned === t.key}
                onPin={onPin}
                className="aspect-video shrink-0"
                style={{ width: `${tileWidth / rem}rem` }}
              />
            ))}
          </div>
          {pager}
        </div>
      )}
    </div>
  )
}

/** The local share would only mirror itself back, so the main slot shows a presenting card instead */
function PresentingCard() {
  const { localParticipant } = useLocalParticipant()
  const stop = () => {
    localParticipant.setScreenShareEnabled(false).catch((err: unknown) => console.error("Stop presenting failed:", err))
  }
  return (
    <div className="flex size-full flex-col items-center justify-center gap-4 rounded-lg bg-app-sunk p-6 text-center">
      <Screencast aria-hidden="true" className="size-8 text-app-text-muted" />
      <p className="text-body font-medium text-app-text">You're presenting to everyone</p>
      <Button variant="outline" onClick={stop}>
        Stop presenting
      </Button>
    </div>
  )
}

function Focus({ main, strip, byKey, pinned, onPin, phone }: Shared & { main: StageTile | "presenting"; strip: StageTile[] }) {
  const box = useRef<HTMLDivElement>(null)
  const { width, height } = useBoxSize(box)
  const rem = remPx()
  const fitted = fitTiles(1, width, height, 0).tileWidth
  const fill = main === "presenting" || main.source === "screen"

  return (
    <div className={cn("flex size-full flex-col gap-2 xl:flex-row", phone && "p-2")}>
      <div ref={box} className="relative min-h-0 min-w-0 flex-1">
        {main === "presenting" ? (
          <PresentingCard />
        ) : (
          (fill || fitted > 0) && (
            <div className="absolute inset-0 flex items-center justify-center">
              <CallTile
                tileId={main.key}
                trackRef={byKey.get(main.key)!}
                pinned={pinned === main.key}
                onPin={onPin}
                className={fill ? "size-full" : "aspect-video"}
                style={fill ? undefined : { width: `${fitted / rem}rem` }}
              />
            </div>
          )
        )}
      </div>
      {strip.length > 0 && (
        <div className="flex h-24 shrink-0 gap-2 overflow-x-auto sm:h-28 xl:h-auto xl:w-60 xl:flex-col xl:overflow-x-hidden xl:overflow-y-auto">
          {strip.map((t) => (
            <CallTile
              key={t.key}
              tileId={t.key}
              trackRef={byKey.get(t.key)!}
              pinned={pinned === t.key}
              onPin={onPin}
              className="aspect-video h-full shrink-0 xl:h-auto xl:w-full"
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Two participants: the remote one fills the stage and the local one floats in the corner, edge to edge on phones */
function Pair({ main, self, byKey, pinned, onPin, phone }: Shared & { main: StageTile; self: StageTile }) {
  return (
    <div className="relative size-full">
      <CallTile
        tileId={main.key}
        trackRef={byKey.get(main.key)!}
        pinned={pinned === main.key}
        onPin={onPin}
        className={cn("size-full", phone && "rounded-none")}
      />
      <div className={cn("absolute right-3 bottom-3", phone ? "w-28" : "w-60")}>
        <CallTile
          tileId={self.key}
          trackRef={byKey.get(self.key)!}
          pinned={pinned === self.key}
          onPin={onPin}
          className={cn("w-full ring-[0.0625rem] ring-app-border", phone ? "aspect-3/4" : "aspect-video")}
        />
      </div>
    </div>
  )
}

const NOTICE = { toasterId: CALL_TOASTER, duration: Infinity, dismissible: false }

/** A lost connection and blocked audio share the stage's one status stack with lobby requests, in the full and the mini call */
export function StageNotices() {
  const state = useConnectionState()
  const reconnecting = state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting
  const { canPlayAudio, startAudio } = useAudioPlayback()

  useEffect(() => {
    if (!reconnecting) return
    toast.custom(
      () => (
        <div className="flex w-full justify-center">
          <p className="flex items-center gap-2 rounded-full bg-app-berry px-3 py-1.5 text-ui font-medium text-app-bg">
            <Spinner className="size-4" />
            Connection lost. Reconnecting
          </p>
        </div>
      ),
      { ...NOTICE, id: "call-reconnecting" },
    )
    return () => void toast.dismiss("call-reconnecting")
  }, [reconnecting])

  const start = useRef(startAudio)
  start.current = startAudio
  useEffect(() => {
    if (canPlayAudio) return
    toast.custom(
      () => (
        <div className="flex w-full justify-center">
          <Button variant="secondary" onClick={() => void start.current()} className="pointer-events-auto rounded-full">
            Turn on call audio
          </Button>
        </div>
      ),
      { ...NOTICE, id: "call-audio" },
    )
    return () => void toast.dismiss("call-audio")
  }, [canPlayAudio])

  return null
}

/** Every camera and screen share in the room: a grid, one main tile with a strip, or the pair view */
export function CallStage({ mode }: { mode: StageMode }) {
  const { tiles, byKey } = useStageTiles()
  const [activeSpeaker, setActiveSpeaker] = useState<string>()
  const [pinned, setPinned] = useState<string>()
  const state = useConnectionState()
  const phone = !useIsDesktop()
  const layout = stageLayout(tiles, { mode, pinned, activeSpeaker })
  const onPin = useCallback((key: string) => setPinned((p) => (p === key ? undefined : key)), [])
  const tracker = mode === "speaker" && <SpeakerTracker onChange={setActiveSpeaker} />
  const shared = { byKey, pinned, onPin, phone }

  if (state === ConnectionState.Connecting || (tiles.length === 0 && state !== ConnectionState.Disconnected)) {
    return (
      <div role="status" className="flex size-full flex-col items-center justify-center gap-3 text-ui text-app-text-muted">
        {tracker}
        <LoadingSpinner size="lg" />
        Joining the call
      </div>
    )
  }

  return (
    <div className="relative size-full">
      {tracker}
      {layout.kind === "grid" && <Grid tiles={layout.tiles} {...shared} />}
      {layout.kind === "focus" && <Focus main={layout.main} strip={layout.strip} {...shared} />}
      {layout.kind === "presenting" && <Focus main="presenting" strip={layout.strip} {...shared} />}
      {layout.kind === "pair" && <Pair main={layout.main} self={layout.self} {...shared} />}
    </div>
  )
}
