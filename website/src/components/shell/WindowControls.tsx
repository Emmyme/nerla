import { useEffect, useState } from "react"
import { isTauri } from "@tauri-apps/api/core"
import type { Window as TauriWindow } from "@tauri-apps/api/window"
import { cn } from "@/lib/utils"

// Native Windows-style glyphs, 1px strokes inside a shared 0.5-9.5 box so they read at one optical weight
function MinimizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <line x1="0.5" y1="5" x2="9.5" y2="5" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function MaximizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function RestoreGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor" strokeWidth="1" />
      <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
      <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

// The web build never loads the Tauri window module
let current: Promise<TauriWindow | null> | null = null
function currentWindow() {
  current ??= import("@tauri-apps/api/window").then((module) => module.getCurrentWindow()).catch(() => null)
  return current
}

const BASE =
  "inline-flex w-11.5 shrink-0 items-center justify-center text-app-text-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-inset focus-visible:ring-ring"
export const WINDOW_BUTTON = `${BASE} hover:bg-app-hover hover:text-app-text active:bg-app-sunk focus-visible:text-app-text`
export const WINDOW_CLOSE = `${BASE} hover:bg-app-berry hover:text-app-bg active:bg-app-berry-text active:text-app-bg focus-visible:bg-app-berry focus-visible:text-app-bg`

/** Minimize, maximize and close for the desktop window. Renders nothing on web. A call can take over minimize */
export function WindowControls({
  closeOnly = false,
  className,
  onMinimize,
}: {
  closeOnly?: boolean
  className?: string
  onMinimize?: () => void
}) {
  const isDesktop = isTauri()
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!isDesktop) return
    let live = true
    let unlisten: (() => void) | undefined
    void currentWindow().then(async (appWindow) => {
      if (!appWindow) return
      const sync = () =>
        appWindow.isMaximized().then(
          (maximized) => live && setIsMaximized(maximized),
          () => {},
        )
      void sync()
      try {
        const off = await appWindow.onResized(() => void sync())
        if (live) unlisten = off
        else off()
      } catch (error) {
        console.debug("Window resize listener unavailable:", error)
      }
    })
    return () => {
      live = false
      unlisten?.()
    }
  }, [isDesktop])

  const run = (action: (w: TauriWindow) => Promise<void>) =>
    void currentWindow().then(async (appWindow) => {
      if (!appWindow) return
      try {
        await action(appWindow)
      } catch (error) {
        console.error("Window control failed:", error)
      }
    })

  if (!isDesktop) return null

  return (
    <div className={cn("app-region-no-drag flex items-stretch", className)}>
      {!closeOnly && (
        <>
          <button
            type="button"
            onClick={onMinimize ?? (() => run((w) => w.minimize()))}
            className={WINDOW_BUTTON}
            title="Minimize"
            aria-label="Minimize"
          >
            <MinimizeGlyph />
          </button>
          <button
            type="button"
            onClick={() => run((w) => w.toggleMaximize())}
            className={WINDOW_BUTTON}
            title={isMaximized ? "Restore" : "Maximize"}
            aria-label={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? <RestoreGlyph /> : <MaximizeGlyph />}
          </button>
        </>
      )}
      <button type="button" onClick={() => run((w) => w.close())} className={WINDOW_CLOSE} title="Close" aria-label="Close">
        <CloseGlyph />
      </button>
    </div>
  )
}
