import { EVENT_MARK } from "./eventColors"

export type PersonTone = "sky" | "pistachio" | "lavender"

const TONES: PersonTone[] = ["sky", "pistachio", "lavender"]

/**
 * Team view overlays sit on the card in the user's color: a full ring and an initials mark in the
 * strong step (the pastel in dark mode), never a side stripe
 */
export const PERSON_STYLE: Record<PersonTone, { ring: string; dot: string; ink: string }> = {
  sky: { ring: EVENT_MARK.sky.ring, dot: EVENT_MARK.sky.bg, ink: "text-app-sky-ink" },
  pistachio: { ring: EVENT_MARK.pistachio.ring, dot: EVENT_MARK.pistachio.bg, ink: "text-app-pistachio-ink" },
  lavender: { ring: EVENT_MARK.lavender.ring, dot: EVENT_MARK.lavender.bg, ink: "text-app-lavender-ink" },
}

/** A stable color per user, the same on every device */
export function colorForPerson(userId: string): PersonTone {
  let hash = 2166136261
  for (let i = 0; i < userId.length; i++) hash = Math.imul(hash ^ userId.charCodeAt(i), 16777619)
  return TONES[(hash >>> 0) % TONES.length]
}

/** "Jane Smith" to "JS", one letter for a single name */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  const letters = words.length === 1 ? words[0][0] : words[0][0] + words[words.length - 1][0]
  return letters.toUpperCase()
}
