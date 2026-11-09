import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useConnectionState, useRoomContext } from "@livekit/components-react"
import { ConnectionState, type Room } from "livekit-client"
import { toast } from "sonner"
import { PortalContainer } from "@/components/ui/portal-container"
import { remPx } from "@/lib/utils"
import { useMediaShortcuts } from "./ControlBar"
import { CALL_TOASTER } from "./incoming"
import { MiniCall } from "./MiniCall"
import { PopOutContext, documentPip, popOutKind } from "./pip"

const SIZE_REM = { width: 20, height: 12 }

type Floating = { win: Window; root: HTMLDivElement }

/** The app's styles, rules where they can be read and links where they can't */
function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement("style")
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n")
      target.head.append(style)
    } catch {
      if (!sheet.href) continue
      const link = target.createElement("link")
      link.rel = "stylesheet"
      link.href = sheet.href
      target.head.append(link)
    }
  }
}

/** A remote screen first, then whoever is speaking, any other remote camera, and the local camera when alone */
function speakerVideo(room: Room): HTMLVideoElement | null {
  const find = (identity: string, source: "camera" | "screen") =>
    document.querySelector<HTMLVideoElement>(`[data-call-stage] [data-tile="${CSS.escape(`${identity}:${source}`)}"] video`)
  const remotes = [...room.remoteParticipants.values()]
  const speakers = room.activeSpeakers.filter((p) => !p.isLocal)
  for (const p of remotes) {
    const screen = find(p.identity, "screen")
    if (screen) return screen
  }
  for (const p of [...speakers, ...remotes]) {
    const camera = find(p.identity, "camera")
    if (camera) return camera
  }
  return find(room.localParticipant.identity, "camera")
}

function FloatingShortcuts({ win }: { win: Window }) {
  useMediaShortcuts(win)
  return null
}

/** Pops the call out of the tab, on request or when the browser asks on a tab switch. Leaving from there ends the call in the tab */
export function PopOutProvider({ onLeave, children }: { onLeave: () => void; children: ReactNode }) {
  const [kind] = useState(popOutKind)
  const connected = useConnectionState() === ConnectionState.Connected
  const room = useRoomContext()
  const [floating, setFloating] = useState<Floating | null>(null)
  const [videoOpen, setVideoOpen] = useState(false)
  const current = useRef(floating)
  current.current = floating

  const openDocument = useCallback(async () => {
    const api = documentPip()
    if (!api || current.current) return
    const rem = remPx()
    let win: Window
    try {
      win = await api.requestWindow({ width: Math.round(SIZE_REM.width * rem), height: Math.round(SIZE_REM.height * rem) })
    } catch (error) {
      console.error("Pop out failed:", error)
      return
    }
    const doc = win.document
    copyStyles(doc)
    doc.title = document.title
    doc.documentElement.setAttribute("data-theme", "nerla")
    doc.documentElement.setAttribute("data-mode", "dark")
    const root = doc.createElement("div")
    root.setAttribute("data-call-stage", "")
    root.setAttribute("data-theme", "nerla")
    root.setAttribute("data-mode", "dark")
    root.className = "flex h-dvh flex-col bg-app-bg text-app-text scheme-dark"
    doc.body.append(root)
    win.addEventListener("pagehide", () => setFloating((open) => (open?.win === win ? null : open)), { once: true })
    setFloating({ win, root })
  }, [])

  const openVideo = useCallback(async () => {
    const video = speakerVideo(room)
    if (!video) {
      toast("There's no video to pop out yet.", { id: "call-pop-out", toasterId: CALL_TOASTER })
      return
    }
    try {
      await video.requestPictureInPicture()
    } catch (error) {
      console.error("Pop out failed:", error)
    }
  }, [room])

  const close = useCallback(() => {
    current.current?.win.close()
    setFloating(null)
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {})
  }, [])

  const open = Boolean(floating) || videoOpen
  const toggle = useCallback(() => {
    if (open) close()
    else if (kind === "document") void openDocument()
    else if (kind === "video") void openVideo()
  }, [open, kind, close, openDocument, openVideo])

  useEffect(() => {
    if (kind !== "video") return
    const sync = () => setVideoOpen(Boolean(document.pictureInPictureElement))
    document.addEventListener("enterpictureinpicture", sync, true)
    document.addEventListener("leavepictureinpicture", sync, true)
    return () => {
      document.removeEventListener("enterpictureinpicture", sync, true)
      document.removeEventListener("leavepictureinpicture", sync, true)
    }
  }, [kind])

  // Chromium opens the pop out by itself on a tab switch during a call, as Meet does
  useEffect(() => {
    if (kind !== "document" || !connected || !("mediaSession" in navigator)) return
    const action = "enterpictureinpicture" as MediaSessionAction
    try {
      navigator.mediaSession.setActionHandler(action, () => void openDocument())
    } catch {
      return
    }
    return () => {
      try {
        navigator.mediaSession.setActionHandler(action, null)
      } catch {
        // Unsupported actions throw, and there is nothing to undo
      }
    }
  }, [kind, connected, openDocument])

  useEffect(() => close, [close])

  const backToTab = useCallback(() => {
    close()
    window.focus()
  }, [close])

  const leave = useCallback(() => {
    close()
    window.focus()
    onLeave()
  }, [close, onLeave])

  const value = useMemo(() => ({ available: kind !== null && connected, open, toggle }), [kind, connected, open, toggle])

  return (
    <PopOutContext.Provider value={value}>
      {children}
      {floating &&
        createPortal(
          <PortalContainer.Provider value={floating.root}>
            <FloatingShortcuts win={floating.win} />
            <MiniCall onExpand={backToTab} onLeave={leave} className="pt-1.5" />
          </PortalContainer.Provider>,
          floating.root,
        )}
    </PopOutContext.Provider>
  )
}
