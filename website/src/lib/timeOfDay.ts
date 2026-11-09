const DAY_MINUTES = 24 * 60

const pad = (n: number) => String(n).padStart(2, "0")

export function toMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const minutes = Number(match[1]) * 60 + Number(match[2])
  return Number(match[1]) < 24 && Number(match[2]) < 60 ? minutes : null
}

function fromMinutes(minutes: number): string {
  const wrapped = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`
}

/**
 * A typed time as "HH:MM" on the 24 hour clock, or null. Takes "930", "14", "9:30", "9.30", "0930"
 * and the 12 hour "3pm" or "3:30 pm".
 */
export function parseTimeOfDay(text: string): string | null {
  const typed = text.trim().toLowerCase().replace(/\s+/g, "")
  const match = /^(\d{1,4})(?:[:.](\d{1,2}))?(am|pm|a|p)?$/.exec(typed)
  if (!match) return null
  const [, digits, after, half] = match
  let hours: number
  let minutes: number
  if (after !== undefined) {
    if (digits.length > 2) return null
    hours = Number(digits)
    minutes = Number(after.length === 1 ? `0${after}` : after)
  } else if (digits.length <= 2) {
    hours = Number(digits)
    minutes = 0
  } else {
    hours = Number(digits.slice(0, -2))
    minutes = Number(digits.slice(-2))
  }
  if (half) {
    if (hours < 1 || hours > 12) return null
    hours = (hours % 12) + (half.startsWith("p") ? 12 : 0)
  }
  if (hours > 23 || minutes > 59) return null
  return `${pad(hours)}:${pad(minutes)}`
}

/** One step up or down, landing on the step grid, round the clock */
export function stepTimeOfDay(value: string, direction: 1 | -1, step: number): string {
  const minutes = toMinutes(value) ?? 0
  const snapped = direction === 1 ? Math.floor(minutes / step) * step + step : Math.ceil(minutes / step) * step - step
  return fromMinutes(snapped)
}

/** Every time on the step grid, from `from` round the clock */
export function timeOptions(step: number, from = 0): string[] {
  const first = Math.ceil(from / step) * step
  return Array.from({ length: Math.ceil(DAY_MINUTES / step) }, (_, i) => fromMinutes(first + i * step))
}

/** "30 min", "1 h" or "1 h 30 min" from the start to the end, past midnight when the end comes first */
export function durationText(start: string, end: string): string | null {
  const from = toMinutes(start)
  const to = toMinutes(end)
  if (from === null || to === null) return null
  const length = (to - from + DAY_MINUTES) % DAY_MINUTES
  const hours = Math.floor(length / 60)
  const minutes = length % 60
  if (hours === 0) return `${minutes} min`
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`
}
