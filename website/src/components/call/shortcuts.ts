export function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent)
}

export function shortcutKeys(letter: string) {
  return isMac() ? `⌘ ${letter}` : `Ctrl ${letter}`
}

function isEditable(target: EventTarget | null) {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false
  const el = target as HTMLElement
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
}

type KeyPress = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "target">

/** Which media toggle a key press asks for, as in Meet: Cmd on a Mac, Ctrl elsewhere, never while typing */
export function mediaShortcut(e: KeyPress, mac: boolean): "mic" | "camera" | null {
  const modifier = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!modifier || e.altKey || e.shiftKey || isEditable(e.target)) return null
  const key = e.key.toLowerCase()
  return key === "d" ? "mic" : key === "e" ? "camera" : null
}
