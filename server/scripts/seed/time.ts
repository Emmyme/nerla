/**
 * Times for the seed in the server's own time zone, or TZ when it is set. Everything is placed from local noon, so a
 * seed run late at night still puts today's events on today
 */

const pad = (n: number) => String(n).padStart(2, "0")

/** The moment the seed treats as now: SEED_NOW when set, such as 2026-11-03T13:00 for screenshots, else the real time */
export function seedNow(): Date {
  if (!process.env.SEED_NOW) return new Date()
  const now = new Date(process.env.SEED_NOW)
  if (isNaN(now.getTime())) throw new Error(`SEED_NOW is "${process.env.SEED_NOW}", which is not a date such as 2026-11-03T13:00`)
  return now
}

/** Noon on the local day `dayOffset` days from `now`, moved by `hours`, which stays within that day below 12 */
export function fromLocalNoon(dayOffset: number, hours = 0, now = seedNow()): Date {
  if (Math.abs(hours) >= 12) throw new Error(`An offset of ${hours} hours from noon leaves the day`)
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 12, Math.round(hours * 60))
}

/** The local date `dayOffset` days from `now`, as YYYY-MM-DD */
export function localDate(dayOffset: number, now = seedNow()): string {
  const day = fromLocalNoon(dayOffset, 0, now)
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

export const daysAgo = (days: number, now = seedNow()): string => fromLocalNoon(-days, 0, now).toISOString()

/** Days from today to a weekday, 0 for Monday, of this week or of the week `weeks` on */
export const weekday = (day: number, weeks = 0, now = seedNow()): number => day + 7 * weeks - ((now.getDay() + 6) % 7)

/** A local wall time, `clock` hours after midnight, `dayOffset` days from today */
export const atClock = (dayOffset: number, clock: number, now = seedNow()): Date => fromLocalNoon(dayOffset, clock - 12, now)
