/**
 * Caret and selection colors in a paper or board, the strong step of each candy token. Other users' editors draw
 * them, so they travel as hex, and the strong step stays legible on both the light and the dark page
 */
export const DOC_COLORS = [
  "#7CC2F7", // --color-sky-strong
  "#A8D477", // --color-pistachio-strong
  "#B39CFF", // --color-lavender-strong
  "#FF6FAE", // --color-bubblegum-strong
  "#F5C542", // --color-lemon-strong
] as const

/** A stable color per user, the same on every device */
export function docColor(userId: string): string {
  let hash = 2166136261
  for (let i = 0; i < userId.length; i++) hash = Math.imul(hash ^ userId.charCodeAt(i), 16777619)
  return DOC_COLORS[(hash >>> 0) % DOC_COLORS.length]
}
