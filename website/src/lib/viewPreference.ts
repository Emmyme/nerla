export function readViewPreference<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const stored = localStorage.getItem(key)
    return allowed.find((value) => value === stored) ?? fallback
  } catch {
    return fallback
  }
}

export function saveViewPreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage can be blocked, the choice then lasts for this visit only
  }
}
