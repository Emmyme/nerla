import { useLayoutEffect, useState, type RefObject } from "react"

/** A board follows the Nerla mode of the place it sits in, which a call keeps dark */
export function useBoardTheme(box: RefObject<HTMLElement | null>): "light" | "dark" {
  const [mode, setMode] = useState<"light" | "dark">("light")
  useLayoutEffect(() => {
    const host = box.current?.closest("[data-mode]") ?? document.documentElement
    const read = () => setMode(host.getAttribute("data-mode") === "dark" ? "dark" : "light")
    read()
    const observer = new MutationObserver(read)
    observer.observe(host, { attributes: true, attributeFilter: ["data-mode"] })
    return () => observer.disconnect()
  }, [box])
  return mode
}

const lightTokens = new Map<string, string>()

/** A Nerla light token as a plain value, whatever the mode around it */
function lightToken(name: string, fallback: string): string {
  const known = lightTokens.get(name)
  if (known) return known
  const probe = document.createElement("div")
  probe.setAttribute("data-theme", "nerla")
  probe.setAttribute("data-mode", "light")
  probe.hidden = true
  document.body.append(probe)
  const value = getComputedStyle(probe).getPropertyValue(name).trim() || fallback
  probe.remove()
  lightTokens.set(name, value)
  return value
}

/**
 * The light page color, for the board's own background. Boards stay light in dark mode so candy colors keep their
 * brightness, so this is read from Nerla's light tokens whatever the mode
 */
export const lightBoardSurface = () => lightToken("--color-surface", "#FFFFFF")

/** Muted text that reads on the light board, for hints drawn over the canvas */
export const lightBoardMutedText = () => lightToken("--color-text-muted", "#58607A")
