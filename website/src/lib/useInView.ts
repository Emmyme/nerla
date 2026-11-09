import { useEffect, useRef, useState } from "react"

const SETTLE_MS = 200

/**
 * Whether the element has settled in view. A tile that only passes by during a fast scroll never counts.
 * With `releaseMs` it stops counting after that long out of view, otherwise it stays seen
 */
export function useSettledInView<T extends Element>(enabled: boolean, releaseMs?: number) {
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!enabled || !node) return
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true)
      return
    }
    let timer: number | undefined
    const observer = new IntersectionObserver((seen) => {
      window.clearTimeout(timer)
      const inView = seen.some((entry) => entry.isIntersecting)
      if (!inView && releaseMs === undefined) return
      timer = window.setTimeout(() => setVisible(inView), inView ? SETTLE_MS : releaseMs)
    })
    observer.observe(node)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [enabled, releaseMs])

  return { ref, visible }
}
