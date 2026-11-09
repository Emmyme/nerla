import { useEffect, useRef, useState } from "react"
import { ArrowsOutSimple, PhoneDisconnect } from "@/components/icons"
import { LoadingSpinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { CallIconButton } from "./CallIconButton"
import { SpeakerTracker, useStageTiles } from "./CallStage"
import { CallTile } from "./CallTile"
import { CameraToggle, MicToggle } from "./ControlBar"
import { stageLayout } from "./stage"

const SMALL = "size-9 [&_svg]:size-4.5"

/** The always-on-top corner window or the pop out: one tile, a remote share if any, else whoever spoke last, else the local tile when alone */
export function MiniCall({ onExpand, onLeave, className }: { onExpand: () => void; onLeave: () => void; className?: string }) {
  const root = useRef<HTMLElement>(null)
  const { tiles, byKey } = useStageTiles()
  const [speaker, setSpeaker] = useState<string>()
  const layout = stageLayout(
    tiles.filter((t) => !(t.local && t.source === "screen")),
    { mode: "speaker", activeSpeaker: speaker },
  )
  const main = layout.kind === "focus" ? layout.main : undefined

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      e.preventDefault()
      onExpand()
    }
    const view = root.current?.ownerDocument.defaultView ?? window
    view.addEventListener("keydown", onKey)
    return () => view.removeEventListener("keydown", onKey)
  }, [onExpand])

  return (
    <main ref={root} className={cn("group/mini relative min-h-0 flex-1 px-1.5 pb-1.5", className)}>
      <SpeakerTracker onChange={setSpeaker} />
      {main ? (
        <CallTile tileId={main.key} trackRef={byKey.get(main.key)!} pinned={false} className="size-full" />
      ) : (
        <div
          role="status"
          className="flex size-full flex-col items-center justify-center gap-2 rounded-lg bg-app-sunk text-caption text-app-text-muted"
        >
          <LoadingSpinner />
          Joining the call
        </div>
      )}
      <div
        role="group"
        aria-label="Call controls"
        className="absolute inset-x-0 bottom-4 flex justify-center gap-1.5 opacity-0 transition-opacity duration-150 group-focus-within/mini:opacity-100 group-hover/mini:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <MicToggle className={SMALL} />
        <CameraToggle className={SMALL} />
        <CallIconButton label="Expand" tip="Back to the full call" onClick={onExpand} className={SMALL}>
          <ArrowsOutSimple aria-hidden="true" />
        </CallIconButton>
        <CallIconButton label="Leave call" onClick={onLeave} className={cn(SMALL, "bg-app-text text-app-bg hover:bg-app-text/85")}>
          <PhoneDisconnect aria-hidden="true" weight="fill" />
        </CallIconButton>
      </div>
    </main>
  )
}
