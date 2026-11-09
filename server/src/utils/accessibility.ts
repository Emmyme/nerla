export const ACCESSIBILITY_KEYS = ["typeShapes", "reduceMotion", "easierReading", "largerText", "moreContrast", "stillZs"] as const

export type AccessibilityKey = (typeof ACCESSIBILITY_KEYS)[number]

/** The choices the user made. One that is missing was never set and reads as off, apart from still z's, which read as on */
export type Accessibility = Partial<Record<AccessibilityKey, boolean>>

/** The stored choices, keeping only known keys with a yes or no */
export function accessibilityOf(stored: unknown): Accessibility {
  const out: Accessibility = { stillZs: true }
  if (!stored || typeof stored !== "object") return out
  for (const key of ACCESSIBILITY_KEYS) {
    const value = (stored as Record<string, unknown>)[key]
    if (typeof value === "boolean") out[key] = value
  }
  return out
}
