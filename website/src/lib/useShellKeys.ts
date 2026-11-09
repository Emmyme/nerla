import { useEffect, useRef } from "react"
import { goToStep, leaveKeyAlone, letterOf } from "@/lib/shortcuts"
import { openShortcuts } from "@/lib/shortcutsDialog"

const REGIONS = ["sidebar", "main", "dock", "tabbar"] as const
type Region = (typeof REGIONS)[number]
const MODAL = '[role="dialog"][aria-modal="true"], [cmdk-root]'
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

const shown = (el: Element) => el.getClientRects().length > 0 && !el.closest("[hidden], [inert]")
const regionEl = (region: Region) => document.querySelector<HTMLElement>(`[data-region="${region}"]`)

/** Where focus lands in a region: the last place it was, or else the sidebar's own stop, main, or the first control */
function landing(region: Region, el: HTMLElement, last: HTMLElement | undefined): HTMLElement | null {
  if (last && el.contains(last) && shown(last)) return last
  if (region === "sidebar") return el.querySelector<HTMLElement>('[data-roving-item][tabindex="0"]')
  if (region === "main") return el
  if (region === "tabbar") return el.querySelector<HTMLElement>('[aria-current="page"]') ?? el.querySelector<HTMLElement>(TABBABLE)
  return Array.from(el.querySelectorAll<HTMLElement>(TABBABLE)).find(shown) ?? null
}

/**
 * Keys that work across the shell: G then a letter goes to a page, ? shows the shortcuts, and F6 or Shift F6 moves
 * between the sidebar, the page and the chat
 */
export function useShellKeys(navigate: (path: string) => void, available: (path: string) => boolean) {
  const latest = useRef({ navigate, available })
  latest.current = { navigate, available }

  useEffect(() => {
    let armedAt: number | null = null
    const last = new Map<Region, HTMLElement>()

    const onFocusIn = (event: FocusEvent) => {
      const region = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-region]")?.dataset.region : undefined
      if (region) last.set(region as Region, event.target as HTMLElement)
    }

    const moveRegion = (back: boolean) => {
      const regions = REGIONS.map((region) => ({ region, el: regionEl(region) })).filter(
        (entry): entry is { region: Region; el: HTMLElement } =>
          !!entry.el && shown(entry.el) && !!landing(entry.region, entry.el, undefined),
      )
      if (regions.length === 0) return
      const active = document.activeElement
      const at = regions.findIndex(({ el }) => active instanceof Node && el.contains(active))
      const step = back ? -1 : 1
      const next = at < 0 ? (back ? regions.length - 1 : 0) : (at + step + regions.length) % regions.length
      const { region, el } = regions[next]
      landing(region, el, last.get(region))?.focus()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === "F6") {
        if (event.ctrlKey || event.altKey || event.metaKey || document.querySelector(MODAL)) return
        event.preventDefault()
        armedAt = null
        moveRegion(event.shiftKey)
        return
      }
      // A held G stays armed
      if (event.repeat) return
      if (event.key === "?") {
        armedAt = null
        if (leaveKeyAlone(event, { altGr: true })) return
        event.preventDefault()
        openShortcuts()
        return
      }
      if (event.shiftKey || leaveKeyAlone(event)) {
        armedAt = null
        return
      }
      const step = goToStep(armedAt, letterOf(event), Date.now())
      armedAt = step.armedAt
      if (!step.goto?.path) return
      // The letter after G belongs to the go-to key, never to the page's own shortcuts
      event.preventDefault()
      event.stopPropagation()
      if (latest.current.available(step.goto.path)) latest.current.navigate(step.goto.path)
    }

    document.addEventListener("focusin", onFocusIn)
    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      document.removeEventListener("focusin", onFocusIn)
      window.removeEventListener("keydown", onKeyDown, true)
    }
  }, [])
}
