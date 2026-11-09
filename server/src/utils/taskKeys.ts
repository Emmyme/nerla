const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,4}$/
const MAX_KEY_LENGTH = 5
const FALLBACK_KEY = "PRJ"

function baseKey(name: string): string {
  const words = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((word) => /^[A-Z]/.test(word))

  const key =
    words.length >= 2
      ? words
          .slice(0, 3)
          .map((word) => word[0])
          .join("")
      : (words[0] ?? "").slice(0, 3)

  return KEY_PATTERN.test(key) ? key : FALLBACK_KEY
}

export function deriveProjectKey(name: string, taken: ReadonlySet<string>): string {
  const base = baseKey(name)
  if (!taken.has(base)) return base

  for (let n = 2; n < 10_000; n++) {
    const suffix = String(n)
    const candidate = base.slice(0, MAX_KEY_LENGTH - suffix.length) + suffix
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`No free project key for "${name}"`)
}

export function formatTaskIdentifier(key: string | null, number: number | null): string | null {
  if (!key || number === null) return null
  return `${key}-${number}`
}
