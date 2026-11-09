import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError } from "@/lib/api/request"
import { busyRetryMs } from "@/lib/authFlow"
import { messageOf } from "@/lib/taskStore"

const STARTUP_RETRY_MS = [5_000, 15_000, 60_000]

/** How long a failed startup check waits before asking again: a 429's own wait, else 5 s, 15 s, then every 60 s */
export function startupRetryMs(err: unknown, attempt: number): number {
  const busy = err instanceof ApiError ? busyRetryMs(err.status, err.retryAfter) : null
  return busy ?? STARTUP_RETRY_MS[Math.min(attempt, STARTUP_RETRY_MS.length - 1)]
}

/** Waits out a 429 and asks again when the server says, instead of showing the rate limit as an error */
export function useBusyRetry() {
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => () => clearTimeout(timer.current), [])

  /** True when `err` was a 429 and `retry` is scheduled */
  const waitIfBusy = useCallback((err: unknown, retry: () => void) => {
    const wait = err instanceof ApiError ? busyRetryMs(err.status, err.retryAfter) : null
    if (wait === null) return false
    setBusy(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(retry, wait)
    return true
  }, [])

  const done = useCallback(() => setBusy(false), [])

  return { busy, waitIfBusy, done }
}

/**
 * Loads once, again when `key` changes and on `reload` or `retry`, and waits out a 429 before it shows `failed`.
 * `retry` also clears the error, for a Try again button.
 */
export function useBusyLoad<T>(load: () => Promise<T>, failed: string, key?: unknown) {
  const [data, setData] = useState<T | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const { busy, waitIfBusy, done } = useBusyRetry()
  const loader = useRef(load)
  loader.current = load
  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  const retry = useCallback(() => {
    setLoadError(null)
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    let live = true
    loader.current().then(
      (next) => {
        if (!live) return
        done()
        setData(next)
        setLoadError(null)
      },
      (err) => {
        if (!live || waitIfBusy(err, reload)) return
        done()
        setLoadError(messageOf(err, failed))
      },
    )
    return () => {
      live = false
    }
  }, [key, attempt, failed, reload, waitIfBusy, done])

  return { data, setData, loadError, busy, reload, retry }
}
