import { isTauri } from "@tauri-apps/api/core"

/** A full-page address for an app route. The desktop build uses a hash router. */
export function appPath(path: string, tauri = isTauri()): string {
  return tauri ? `/#${path}` : path
}

type PageLocation = Pick<Location, "replace" | "reload"> & { href: string }

/**
 * Loads the app afresh at a route, so the session and every cache start over. On the desktop build only the
 * hash changes, which never reloads by itself.
 */
export function loadApp(path: string, tauri = isTauri(), location: PageLocation = window.location): void {
  if (!tauri) {
    location.href = path
    return
  }
  location.replace(appPath(path, true))
  location.reload()
}
