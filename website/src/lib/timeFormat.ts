/** Whole minutes as "1h 30m", "1h" or "45m" */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest}m`
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

const CLOCK = /^(\d+):([0-5]\d)$/
const UNITS = /^(?:(\d+(?:[.,]\d+)?)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in)?)?$/

/** "1h 30m", "1h", "45m", "45", "1.5h", "1,5h" or "1:30" in whole minutes, or null when it reads as nothing */
export function parseDuration(text: string): number | null {
  const value = text.trim().toLowerCase()
  let minutes: number | null = null
  const clock = CLOCK.exec(value)
  const units = UNITS.exec(value)
  if (/^\d+$/.test(value)) minutes = Number(value)
  else if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2])
  else if (units && (units[1] || units[2])) minutes = Math.round(Number((units[1] ?? "0").replace(",", ".")) * 60) + Number(units[2] ?? 0)
  return minutes && minutes > 0 ? minutes : null
}

/** Today's date in a time zone, as YYYY-MM-DD. The device's zone when none is set */
export function todayIn(timeZone: string | null | undefined, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      now,
    )
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
  }
}

/** The Monday of a YYYY-MM-DD date's week */
export function mondayOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  return day.toISOString().slice(0, 10)
}

/** A running timer's length as h:mm:ss */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}
