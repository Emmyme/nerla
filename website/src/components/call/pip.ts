import { createContext, useContext } from "react"
import { isTauri } from "@tauri-apps/api/core"

type DocumentPip = {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
  readonly window: Window | null
}

export function documentPip(): DocumentPip | undefined {
  return (window as Window & { documentPictureInPicture?: DocumentPip }).documentPictureInPicture
}

/** A floating window with the corner call where the browser has one, else the speaker's video alone. The desktop app has its own corner window */
type PopOutKind = "document" | "video"

export function popOutKind(): PopOutKind | null {
  if (typeof window === "undefined" || isTauri()) return null
  if (documentPip()) return "document"
  if (document.pictureInPictureEnabled) return "video"
  return null
}

type PopOut = {
  /** False outside a connected call and where the browser can't pop out */
  available: boolean
  open: boolean
  toggle: () => void
}

export const PopOutContext = createContext<PopOut>({ available: false, open: false, toggle: () => {} })

export const usePopOut = () => useContext(PopOutContext)
