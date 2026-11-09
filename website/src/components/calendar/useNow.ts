import { useEffect, useState } from "react"
import { startOfDay } from "@/lib/dates"

const MINUTE_MS = 60_000

/** The current time, updated on each minute and when the page becomes visible again */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const current = new Date()
      setNow(current)
      timer = setTimeout(tick, MINUTE_MS - (current.getTime() % MINUTE_MS))
    }
    timer = setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS))
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      clearTimeout(timer)
      tick()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  return now
}

const startOfToday = () => startOfDay(new Date())

/** Midnight of the current day, the same object until the date changes, so a page holding it re-renders once a day */
export function useToday(): Date {
  const [today, setToday] = useState(startOfToday)

  useEffect(() => {
    const check = () => {
      const next = startOfToday()
      setToday((shown) => (shown.getTime() === next.getTime() ? shown : next))
    }
    const timer = setInterval(check, MINUTE_MS)
    document.addEventListener("visibilitychange", check)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", check)
    }
  }, [])

  return today
}
