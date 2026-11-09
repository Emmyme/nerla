import { isTauri } from "@tauri-apps/api/core"
import { doNotDisturb } from "@/lib/presenceStore"

// The desktop build imports the Tauri plugin dynamically, so the web bundle never pulls it in
const ICON = "/favicon.png"

type NotifyOptions = {
  body?: string
  /** Web only, desktop notifications don't support per-tag replace. */
  tag?: string
  /** Web only. Defaults to the app icon. */
  icon?: string
  /** Web only. The window comes to the front first. */
  onClick?: () => void
}

/** Safe to call on every mount, it will not re-prompt once decided. */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined") return false

  if (isTauri()) {
    const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification")
    if (await isPermissionGranted()) return true
    return (await requestPermission()) === "granted"
  }

  if (!("Notification" in window)) return false
  if (Notification.permission === "granted") return true
  if (Notification.permission === "denied") return false
  return (await Notification.requestPermission()) === "granted"
}

/** Show a notification. Silently does nothing under do not disturb, without permission, or if the platform refuses it. */
export async function notify(title: string, options: NotifyOptions = {}): Promise<void> {
  if (typeof window === "undefined" || doNotDisturb()) return

  try {
    if (isTauri()) {
      const { isPermissionGranted, sendNotification } = await import("@tauri-apps/plugin-notification")
      if (!(await isPermissionGranted())) return
      // The plugin takes icon as a file path or system icon name, not a web path, so desktop keeps its default
      sendNotification({ title, body: options.body })
      return
    }

    if (!("Notification" in window) || Notification.permission !== "granted") {
      return
    }
    // Android Chrome throws here, it only shows notifications from a service worker
    const shown = new Notification(title, {
      body: options.body,
      icon: options.icon ?? ICON,
      tag: options.tag,
    })
    const { onClick } = options
    if (onClick) {
      shown.onclick = () => {
        window.focus()
        shown.close()
        onClick()
      }
    }
  } catch {
    return
  }
}
