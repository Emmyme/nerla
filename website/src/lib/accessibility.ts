import { useSyncExternalStore } from "react"
import { usersAPI } from "@/lib/api/users"
import { matchesMedia } from "./useMediaQuery"

export type AccessibilityKey = "typeShapes" | "reduceMotion" | "easierReading" | "largerText" | "moreContrast" | "stillZs"
export type AccessibilityChoices = Record<AccessibilityKey, boolean>
/** What the account holds. A choice never made is missing and reads as off */
export type SavedAccessibility = Partial<AccessibilityChoices>

export const ACCESSIBILITY_DEFAULTS: AccessibilityChoices = {
  typeShapes: false,
  reduceMotion: false,
  easierReading: false,
  largerText: false,
  moreContrast: false,
  stillZs: true,
}

/** The last choices this browser saw, read by public/theme-init.js before first paint. The account is the source of truth */
const HINT_KEY = "nerla-a11y"
const MOTION_QUERY = "(prefers-reduced-motion: reduce)"
const CONTRAST_QUERY = "(prefers-contrast: more)"

type Device = { reduceMotion: boolean; moreContrast: boolean }

/** The root attributes for the user's choices and what the device asks for */
export function rootState(choices: AccessibilityChoices, device: Device) {
  return {
    motion: choices.reduceMotion || device.reduceMotion ? "reduce" : "full",
    still: choices.reduceMotion,
    contrast: choices.moreContrast || device.moreContrast ? "more" : "normal",
    reading: choices.easierReading ? "easier" : "normal",
    text: choices.largerText ? "larger" : "normal",
    zs: choices.stillZs ? "still" : "moving",
  } as const
}

function pick(value: unknown): SavedAccessibility {
  const out: SavedAccessibility = {}
  if (!value || typeof value !== "object") return out
  for (const key of Object.keys(ACCESSIBILITY_DEFAULTS) as AccessibilityKey[]) {
    const choice = (value as Record<string, unknown>)[key]
    if (typeof choice === "boolean") out[key] = choice
  }
  return out
}

/** What the account holds on top of the defaults, so a choice never made reads as the default */
export function choicesOf(saved: unknown): AccessibilityChoices {
  return { ...ACCESSIBILITY_DEFAULTS, ...pick(saved) }
}

function readHint(): AccessibilityChoices {
  let hint: SavedAccessibility = {}
  try {
    hint = pick(JSON.parse(localStorage.getItem(HINT_KEY) ?? "null"))
  } catch {
    hint = {}
  }
  return { ...ACCESSIBILITY_DEFAULTS, ...hint }
}

function saveHint() {
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify(choices))
  } catch {
    // Storage can be blocked, the account still holds the choices
  }
}

let choices: AccessibilityChoices = ACCESSIBILITY_DEFAULTS
let signedIn = false
let started = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

function apply() {
  const root = document.documentElement
  const state = rootState(choices, { reduceMotion: matchesMedia(MOTION_QUERY), moreContrast: matchesMedia(CONTRAST_QUERY) })
  root.setAttribute("data-motion", state.motion)
  root.toggleAttribute("data-still", state.still)
  root.setAttribute("data-contrast", state.contrast)
  root.setAttribute("data-reading", state.reading)
  root.setAttribute("data-text", state.text)
  root.setAttribute("data-zs", state.zs)
}

/** Applies the last known choices and follows the device's own motion and contrast settings. Runs once, before the first render */
export function startAccessibility() {
  if (started || typeof window === "undefined") return
  started = true
  choices = readHint()
  apply()
  for (const query of [MOTION_QUERY, CONTRAST_QUERY]) {
    if (typeof window.matchMedia === "function") window.matchMedia(query).addEventListener("change", apply)
  }
  // Another tab changed a choice
  window.addEventListener("storage", (event) => {
    if (event.key !== HINT_KEY) return
    choices = readHint()
    apply()
    notify()
  })
}

/** Takes the account's choices once the user is known */
export function adoptAccountAccessibility(saved: unknown) {
  choices = choicesOf(saved)
  signedIn = true
  apply()
  saveHint()
  notify()
}

/** Signing out turns every choice off, apart from what the device asks for */
export function leaveAccountAccessibility() {
  signedIn = false
  choices = ACCESSIBILITY_DEFAULTS
  apply()
  saveHint()
  notify()
}

/** The latest save of each choice, so an older one failing never undoes a newer change */
const latestSave: Partial<Record<AccessibilityKey, number>> = {}

/** Changes one choice at once and saves it to the account. A failed save puts it back, unless a newer change came since, and throws */
export async function setAccessibility(key: AccessibilityKey, on: boolean) {
  const before = choices[key]
  choices = { ...choices, [key]: on }
  apply()
  saveHint()
  notify()
  if (!signedIn) return
  const request = (latestSave[key] ?? 0) + 1
  latestSave[key] = request
  try {
    await usersAPI.updateProfile({ accessibility: { [key]: on } })
  } catch (error) {
    if (latestSave[key] !== request) return
    choices = { ...choices, [key]: before }
    apply()
    saveHint()
    notify()
    throw error
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAccessibility(): AccessibilityChoices {
  return useSyncExternalStore(
    subscribe,
    () => choices,
    () => ACCESSIBILITY_DEFAULTS,
  )
}
