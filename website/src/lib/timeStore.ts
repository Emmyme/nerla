import { useSyncExternalStore } from "react"
import { toast } from "sonner"
import { ApiError } from "@/lib/api/request"
import { timeAPI, type TimeEntry, type TimePlace, type TimerDto } from "@/lib/api/time"
import { onSocketReconnect, onTimeEvent, type TimeEvent } from "@/lib/socket"
import { messageOf } from "@/lib/taskStore"
import { formatMinutes, mondayOf } from "@/lib/timeFormat"
import { startupRetryMs } from "@/lib/useBusyRetry"

export type TimeTracking = { enabled: boolean; timer: TimerDto | null; canReport: boolean; autofillProjectId: string | null }

const TIME_OFF: TimeTracking = { enabled: false, timer: null, canReport: false, autofillProjectId: null }

const START_FAILED = "Couldn't start the timer. Try again."
const STOP_FAILED = "Couldn't stop the timer. Try again."
const LOCKED = "That day is locked, so the running timer was not logged"
const UNDER_A_MINUTE = "Under a minute, nothing logged"
// One id, so the reply and the push of the same stop show one toast
const lockedToast = () => toast(LOCKED, { id: "time-locked" })

export function applyTimeEvent(state: TimeTracking, event: TimeEvent): TimeTracking {
  if (event.type === "time:enabled") return event.enabled ? { ...state, enabled: true } : TIME_OFF
  if (event.type === "time:timer") return state.enabled ? { ...state, timer: event.timer } : state
  return state
}

let state: TimeTracking = TIME_OFF
let generation = 0
// The checks already shown, so a reconnect does not show the same ones again
let shownChecks: string | null = null
// Whether the first state read has answered, so a page can tell off from not known yet
let ready = false
let retry: ReturnType<typeof setTimeout> | undefined
// Failures in a row, so a page still waiting can say it is trying again
let failures = 0
const listeners = new Set<() => void>()
const changeListeners = new Set<(dates: string[]) => void>()

function commit(next: TimeTracking) {
  if (next === state) return
  state = next
  listeners.forEach((listener) => listener())
}

function markReady() {
  if (ready) return
  ready = true
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function showChecks(checks: TimeEntry[]) {
  if (!checks.length) return
  const ids = checks.map((check) => check.id)
  const key = [...ids].sort().join(",")
  if (key === shownChecks) return
  shownChecks = key
  toast("Your timer stopped by itself after 10 hours", {
    duration: 15000,
    action: {
      label: "Check",
      onClick: () => {
        const week = mondayOf(checks[0].date)
        void import("@/router").then(({ router }) => router.navigate(`/time?week=${week}`))
        timeAPI.checksSeen(ids).catch(() => undefined)
      },
    },
  })
}

async function load() {
  const at = generation
  clearTimeout(retry)
  try {
    const loaded = await timeAPI.state()
    if (at !== generation) return
    failures = 0
    if (!loaded.enabled) commit(TIME_OFF)
    else commit({ enabled: true, timer: loaded.timer, canReport: loaded.canReport, autofillProjectId: loaded.autofillProjectId })
    markReady()
    if (loaded.enabled) showChecks(loaded.checks)
  } catch (err) {
    // Not ready yet keeps the page loading instead of reading a failed check as time tracking off
    if (at !== generation) return
    clearTimeout(retry)
    retry = setTimeout(() => void load(), startupRetryMs(err, failures++))
    listeners.forEach((listener) => listener())
  }
}

function onEvent(event: TimeEvent) {
  commit(applyTimeEvent(state, event))
  if (event.type === "time:enabled" && event.enabled) void load()
  else if (event.type === "time:changed") changeListeners.forEach((listener) => listener(event.dates))
  else if (event.type === "time:timer" && event.stoppedLocked) lockedToast()
  else if (event.type === "time:timer" && event.stopped?.needsCheck) showChecks([event.stopped])
}

/** Starts with the shell: one request for the state, then the socket keeps it current */
export function startTimeTracking(): () => void {
  const offs = [onTimeEvent(onEvent), onSocketReconnect(() => void load())]
  void load()
  return () => {
    offs.forEach((off) => off())
    generation += 1
    clearTimeout(retry)
    failures = 0
    shownChecks = null
    ready = false
    commit(TIME_OFF)
  }
}

/** Reads the state again, such as after a workspace switch */
export function reloadTimeTracking() {
  void load()
}

export function setAutofillProject(autofillProjectId: string | null) {
  if (state.enabled) commit({ ...state, autofillProjectId })
}

/** A 404 means the workspace turned time tracking off meanwhile */
function failed(err: unknown, fallback: string) {
  if (err instanceof ApiError && err.status === 404) void load()
  toast.error(messageOf(err, fallback))
}

const logged = (entry: TimeEntry) => toast.success(`Logged ${formatMinutes(entry.minutes)}`)

/** Starting while a timer runs stops and logs that one first */
export async function startTimer(target: TimePlace & { note?: string | null }): Promise<boolean> {
  const wasRunning = !!state.timer
  try {
    const result = await timeAPI.startTimer(target)
    commit({ ...state, timer: result.timer })
    if (result.stoppedLocked) lockedToast()
    else if (result.stopped) logged(result.stopped)
    else if (wasRunning) toast(UNDER_A_MINUTE)
    return true
  } catch (err) {
    failed(err, START_FAILED)
    return false
  }
}

export async function stopTimer(): Promise<boolean> {
  try {
    const result = await timeAPI.stopTimer()
    commit({ ...state, timer: null })
    if (result.locked) lockedToast()
    else if (result.entry) logged(result.entry)
    else toast(UNDER_A_MINUTE)
    return true
  } catch (err) {
    failed(err, STOP_FAILED)
    return false
  }
}

/** The user's entries on these dates changed, here or in another session */
export function onTimeChanged(callback: (dates: string[]) => void): () => void {
  changeListeners.add(callback)
  return () => {
    changeListeners.delete(callback)
  }
}

export function useTimeTracking(): TimeTracking {
  return useSyncExternalStore(subscribe, () => state)
}

/** False until the first state read answers */
export function useTimeTrackingReady(): boolean {
  return useSyncExternalStore(subscribe, () => ready)
}

/** True once a state read has failed, until one answers */
export function useTimeTrackingRetrying(): boolean {
  return useSyncExternalStore(subscribe, () => failures > 0)
}
