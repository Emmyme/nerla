import { useEffect } from "react"

const inToasts = (node: EventTarget | null) => node instanceof Element && !!node.closest("[data-sonner-toaster]")

/**
 * A modal dialog keeps focus inside it and hides the page from screen readers, but toasts stay reachable: Alt+T moves
 * focus to them, and Escape, Tab out or a toast going away hands it back to where it was
 */
export function useToastsReachable() {
  useEffect(() => {
    const body = document.body
    let from: HTMLElement | null = null
    let watch: MutationObserver | null = null
    let settle = 0

    const leave = () => {
      watch?.disconnect()
      watch = null
      from = null
    }
    const dropped = () => !document.activeElement || document.activeElement === body
    const goBack = () => {
      const target = from
      leave()
      if (target?.isConnected) target.focus()
      else if (dropped()) Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]')).pop()?.focus()
    }

    // Focus traps listen on the document, so focus moving to or from the toasts stops at the body
    const onFocusIn = (event: FocusEvent) => {
      if (!inToasts(event.target)) return
      event.stopPropagation()
      if (from || !(event.relatedTarget instanceof HTMLElement) || inToasts(event.relatedTarget)) return
      from = event.relatedTarget
      // A browser that drops focus without a focusout when the toast holding it closes
      const region = (event.target as Element).closest("[data-sonner-toaster]")?.parentElement
      if (!region) return
      watch = new MutationObserver(() => dropped() && goBack())
      watch.observe(region, { childList: true, subtree: true })
    }
    const onFocusOut = (event: FocusEvent) => {
      if (inToasts(event.relatedTarget)) {
        event.stopPropagation()
        return
      }
      if (!from || !inToasts(event.target)) return
      if (event.relatedTarget) return leave()
      // A closing toast or another window takes focus with nowhere named, so where it went shows a moment later
      clearTimeout(settle)
      settle = window.setTimeout(() => {
        if (dropped()) goBack()
        else if (!inToasts(document.activeElement)) leave()
      })
    }
    // Escape in the toasts goes back, and never closes the dialog or anything else behind them
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !inToasts(event.target)) return
      event.stopImmediatePropagation()
      // Sonner reads the code alone, so it folds the stack and its timers run again, and nothing reading the key acts
      document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }))
      if (!from?.isConnected) (event.target as HTMLElement).blur()
      goBack()
    }

    body.addEventListener("focusin", onFocusIn)
    body.addEventListener("focusout", onFocusOut)
    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      clearTimeout(settle)
      leave()
      body.removeEventListener("focusin", onFocusIn)
      body.removeEventListener("focusout", onFocusOut)
      window.removeEventListener("keydown", onKeyDown, true)
    }
  }, [])
}
