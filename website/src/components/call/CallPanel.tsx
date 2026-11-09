import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react"
import { isTauri } from "@tauri-apps/api/core"
import { ArrowLeft, X } from "@/components/icons"
import { cn, remPx } from "@/lib/utils"
import { CallIconButton } from "./CallIconButton"

const WIDE_REM = 36
// A board's tools need the full 36rem in a row, so the panel never gets narrower than it starts
const MIN_WIDTH_REM = WIDE_REM
const KEY_STEP_REM = 2

/** Drags the wide panel's left edge, between 36rem and half the stage. The arrow keys move it too */
function ResizeHandle({ panel, width, onWidth }: { panel: RefObject<HTMLElement>; width: number | null; onWidth: (rem: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const clamp = (px: number) => {
    const row = panel.current?.parentElement?.clientWidth ?? px * 2
    return Math.max(MIN_WIDTH_REM, Math.min(row / 2, px) / remPx())
  }
  const current = () => panel.current?.getBoundingClientRect().width ?? 0
  // Half the stage, read again whenever the stage changes size
  const [max, setMax] = useState(WIDE_REM)
  useLayoutEffect(() => {
    const row = panel.current?.parentElement
    if (!row) return
    const measure = () => setMax(Math.max(MIN_WIDTH_REM, Math.round(row.clientWidth / 2 / remPx())))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [panel])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, width: current() }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onWidth(clamp(drag.current.width + drag.current.x - event.clientX))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0
    if (!step) return
    event.preventDefault()
    onWidth(clamp(current() + step * KEY_STEP_REM * remPx()))
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuemin={MIN_WIDTH_REM}
      aria-valuemax={max}
      aria-valuenow={Math.min(Math.round(width ?? WIDE_REM), max)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -left-3.5 flex w-3 cursor-col-resize touch-none items-center justify-center outline-none max-lg:hidden"
    >
      <span className="h-10 w-1 rounded-full bg-app-text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-60 group-focus-visible:opacity-100" />
    </div>
  )
}

/**
 * The one side panel on the stage: 20rem on the right, a full-screen sheet on phones that keeps the desktop titlebar clear.
 * A wide panel starts at 36rem, its narrowest, and its edge drags out to half the stage. A hidden panel keeps what it holds
 */
export function CallPanel({
  title,
  onClose,
  children,
  actions,
  wide = false,
  hidden = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  /** Buttons in the header, before close */
  actions?: ReactNode
  wide?: boolean
  hidden?: boolean
}) {
  const root = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const headingId = useId()
  const [width, setWidth] = useState<number | null>(null)

  // A child that wants focus, such as the chat box, takes it first
  useEffect(() => {
    if (!hidden && !root.current?.contains(document.activeElement)) heading.current?.focus()
  }, [hidden])

  return (
    <aside
      ref={root}
      aria-labelledby={headingId}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return
        e.preventDefault()
        onClose()
      }}
      style={wide && width !== null ? ({ "--panel-width": `${width}rem` } as CSSProperties) : undefined}
      className={cn(
        "relative flex min-h-0 flex-col bg-app-bg max-lg:fixed max-lg:inset-x-0 max-lg:top-titlebar max-lg:bottom-0 max-lg:z-20 lg:mr-4 lg:mb-2 lg:shrink-0 lg:rounded-xl lg:bg-app-surface",
        wide ? "lg:w-(--panel-width,36rem) lg:max-w-[max(50%,36rem)]" : "lg:w-80",
        !isTauri() && "lg:mt-4",
        hidden && "hidden",
      )}
    >
      {wide && <ResizeHandle panel={root} width={width} onWidth={setWidth} />}
      <header className="flex h-14 shrink-0 items-center gap-2 px-2 lg:pl-4">
        <CallIconButton label="Back to the call" side="bottom" onClick={onClose} className="bg-transparent lg:hidden">
          <ArrowLeft aria-hidden="true" />
        </CallIconButton>
        <h2
          ref={heading}
          id={headingId}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate text-title font-semibold text-app-text outline-none"
        >
          {title}
        </h2>
        {actions}
        <CallIconButton
          label={`Close ${title.toLowerCase()}`}
          side="bottom"
          onClick={onClose}
          className="size-8 bg-transparent max-lg:hidden [&_svg]:size-4"
        >
          <X aria-hidden="true" />
        </CallIconButton>
      </header>
      {children}
    </aside>
  )
}
