import { useEffect, useSyncExternalStore } from "react"
import { presenceAPI, type PresenceEntry } from "@/lib/api/users"
import { activeStatus, type StatusChoice, type StatusOverride } from "@/lib/presence"
import { onPresence, onPresenceCalendar, onSocketReconnect, setPresenceIdle } from "@/lib/socket"

const MAX_IDS = 200
const BATCH_MS = 50
// The user's own badge waits a little, so it rides along with the list the screen is still loading
const LAZY_MS = 1500
const MAX_WAIT_MS = 60 * 60_000
// A test run can shorten this with VITE_PRESENCE_IDLE_MS in development only
const IDLE_MS = (import.meta.env.DEV && Number(import.meta.env.VITE_PRESENCE_IDLE_MS)) || 10 * 60_000
const INPUT_THROTTLE_MS = 5000
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const

const entries = new Map<string, PresenceEntry>()
/** Ids the server did not answer for, such as a user who left the workspace */
const missing = new Set<string>()
const watchers = new Map<string, number>()
const listeners = new Set<() => void>()
const queued = new Set<string>()
const inFlight = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | undefined
let flushAt = Infinity
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let ownId: string | null = null

const notify = () => listeners.forEach((listener) => listener())

function request(ids: Iterable<string>, wait = BATCH_MS) {
  for (const id of ids) if (!inFlight.has(id)) queued.add(id)
  if (queued.size === 0 || Date.now() + wait >= flushAt) return
  clearTimeout(flushTimer)
  flushAt = Date.now() + wait
  flushTimer = setTimeout(flush, wait)
}

async function flush() {
  flushTimer = undefined
  flushAt = Infinity
  const ids = [...queued]
  queued.clear()
  for (let start = 0; start < ids.length; start += MAX_IDS) {
    const batch = ids.slice(start, start + MAX_IDS)
    batch.forEach((id) => inFlight.add(id))
    try {
      const { people } = await presenceAPI.query(batch)
      for (const id of batch) {
        const entry = people[id]
        if (entry) entries.set(id, entry)
        else missing.add(id)
      }
      notify()
    } catch {
      // Left unknown, so the next screen that shows them asks again
    } finally {
      batch.forEach((id) => inFlight.delete(id))
    }
  }
  scheduleRefresh()
}

/** Asks again for the users whose calendar state is due to change, in one request */
function scheduleRefresh() {
  clearTimeout(refreshTimer)
  let next = Infinity
  for (const id of watchers.keys()) {
    const at = Date.parse(entries.get(id)?.changesAt ?? "")
    if (at < next) next = at
  }
  if (next === Infinity) return
  refreshTimer = setTimeout(
    () => {
      const due = Date.now() + 1000
      request([...watchers.keys()].filter((id) => Date.parse(entries.get(id)?.changesAt ?? "") <= due))
    },
    Math.min(Math.max(next - Date.now() + 500, 0), MAX_WAIT_MS),
  )
}

function watch(id: string, lazy: boolean): () => void {
  watchers.set(id, (watchers.get(id) ?? 0) + 1)
  if (!entries.has(id) && !missing.has(id)) request([id], lazy ? LAZY_MS : BATCH_MS)
  return () => {
    const count = (watchers.get(id) ?? 1) - 1
    if (count > 0) watchers.set(id, count)
    else watchers.delete(id)
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A user's presence, fetched with every other user on screen in one request and kept live by the socket */
export function usePresenceEntry(userId: string | null | undefined, lazy = false): PresenceEntry | undefined {
  const id = userId?.toLowerCase() ?? null
  useEffect(() => (id ? watch(id, lazy) : undefined), [id, lazy])
  return useSyncExternalStore(subscribe, () => (id ? entries.get(id) : undefined))
}

function ownEntry(): PresenceEntry | undefined {
  return ownId ? entries.get(ownId) : undefined
}

/** The user's own chosen status while it lasts, or null for automatic */
export function useOwnStatus(): StatusChoice | null {
  const entry = useSyncExternalStore(subscribe, ownEntry)
  return activeStatus(entry?.status, new Date())
}

/** Do not disturb mutes notifications, toasts and ringing while it lasts */
export function doNotDisturb(): boolean {
  return activeStatus(ownEntry()?.status, new Date())?.value === "dnd"
}

/** Sets the user's status and shows it at once, before the live event comes back */
export async function setOwnStatus(status: StatusOverride | "auto", until: string | null): Promise<StatusChoice | null> {
  const result = await presenceAPI.setStatus(status, until)
  const entry = ownEntry()
  if (ownId && entry) {
    entries.set(ownId, { ...entry, status: result.status })
    notify()
  } else if (ownId) request([ownId])
  return result.status
}

/** Drops what is not on screen, so it is asked for fresh when it shows again */
function forgetUnwatched() {
  for (const id of entries.keys()) if (!watchers.has(id)) entries.delete(id)
  missing.clear()
}

let stop: (() => void) | null = null

function trackActivity(): () => void {
  let idle = false
  let lastInput = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const input = () => {
    const now = Date.now()
    if (!idle && now - lastInput < INPUT_THROTTLE_MS) return
    lastInput = now
    idle = false
    setPresenceIdle(false)
    clearTimeout(timer)
    timer = setTimeout(() => {
      idle = true
      setPresenceIdle(true)
    }, IDLE_MS)
  }
  const visibility = () => {
    if (!document.hidden) input()
  }
  input()
  INPUT_EVENTS.forEach((type) => window.addEventListener(type, input, { passive: true, capture: true }))
  document.addEventListener("visibilitychange", visibility)
  return () => {
    clearTimeout(timer)
    INPUT_EVENTS.forEach((type) => window.removeEventListener(type, input, { capture: true }))
    document.removeEventListener("visibilitychange", visibility)
  }
}

/** Starts after the socket, on sign-in. The user's own entry stays watched, for their status. */
export function startPresence(userId: string) {
  if (stop) return
  ownId = userId.toLowerCase()
  const offs = [
    watch(ownId, true),
    onPresence((event) => {
      const id = event.userId.toLowerCase()
      const entry = entries.get(id)
      if (!entry) return
      const { online, idle, inCall } = event
      entries.set(id, { ...entry, online, idle, inCall, status: "status" in event ? event.status : entry.status })
      notify()
    }),
    onPresenceCalendar(({ userIds }) => {
      const ids = userIds.map((id) => id.toLowerCase())
      ids.forEach((id) => !watchers.has(id) && entries.delete(id))
      request(ids.filter((id) => watchers.has(id)))
    }),
    onSocketReconnect(() => {
      forgetUnwatched()
      request(watchers.keys())
    }),
    trackActivity(),
  ]
  stop = () => offs.forEach((off) => off())
}

export function stopPresence() {
  stop?.()
  stop = null
  ownId = null
  clearTimeout(refreshTimer)
  clearTimeout(flushTimer)
  flushTimer = undefined
  flushAt = Infinity
  queued.clear()
  entries.clear()
  missing.clear()
  notify()
}
