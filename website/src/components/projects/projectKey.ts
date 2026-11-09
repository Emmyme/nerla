export const KEY_HINT = "Used in task IDs like WEB-12. Leave empty to generate one."
export const KEY_TAKEN = "That key is taken. Pick a different one."

export function formatProjectKey(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5)
}

export function projectKeyError(key: string): string | null {
  if (key === "") return null
  if (!/^[A-Z]/.test(key)) return "Start the key with a letter"
  if (key.length < 2) return "Use at least 2 characters"
  return null
}
