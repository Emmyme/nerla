import { isTauri } from "@tauri-apps/api/core"
import { getServerUrlSync } from "@/lib/serverUrl"

// Imported before Excalidraw, which reads this when it registers its fonts. The web build carries the fonts, the
// desktop installer leaves them out and the app takes them from the user's own Nerla server
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

if (typeof window !== "undefined") {
  window.EXCALIDRAW_ASSET_PATH =
    isTauri() && import.meta.env.PROD
      ? `${getServerUrlSync()}/excalidraw-assets/`
      : new URL(`${import.meta.env.BASE_URL}excalidraw-assets/`, window.location.href).href
}

export {}
