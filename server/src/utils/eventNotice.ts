import type { Via } from "./aiTypes"
import { parseInstant, storedMs } from "./eventTime"
import type { EventChanges, Guest, SeriesState } from "./seriesEdit"

export type EventChange = "invited" | "moved" | "cancelled" | "restored"

/** Kept on the notification when it is sent, so a cancel still reads right once the event is in Trash */
export type EventNoticeDetail = { change: EventChange; startsAt: string; allDay: boolean; title: string; via: Via | null }

/**
 * Guests who haven't declined, and the organiser when another user made the change. Never the user who made it, and
 * only the organiser for an Everyone event
 */
export function eventChangeRecipients(guests: Guest[], actorId: string, everyone: boolean, organiserId?: string): string[] {
  if (everyone) return organiserId && organiserId !== actorId ? [organiserId] : []
  const told = guests.filter((guest) => guest.response !== "no").map((guest) => guest.userId)
  return [...new Set([...told, ...(organiserId ? [organiserId] : [])])].filter((id) => id !== actorId)
}

const sameSecond = (a: number, b: number) => Math.floor(a / 1000) === Math.floor(b / 1000)

type Move = { startsAt: string; allDay: boolean; guests: Guest[]; everyone: boolean }

/**
 * Whether an edit moves the occurrence it names, and to when, with the guests it had before. Only a new start or end
 * counts, so a resend of the same times moves nothing. Guests the edit removes or adds hear nothing of the move
 */
export function moveOf(state: SeriesState, changes: EventChanges, occurrence: string | undefined): Move | null {
  if (changes.starts_at === undefined && changes.ends_at === undefined) return null
  const { target, master } = state
  const at = occurrence === undefined ? null : parseInstant(occurrence)
  const series = !target.seriesId && target.recurrenceRule && master ? master : null
  const override = series && at !== null ? state.overrides.find((row) => sameSecond(storedMs(row.originalStart) ?? NaN, at)) : undefined
  const row = series && at !== null ? (override && !override.cancelled ? override : null) : target
  const length = (storedMs(target.endsAt) ?? 0) - (storedMs(target.startsAt) ?? 0)
  const before = row ? { start: storedMs(row.startsAt), end: storedMs(row.endsAt) } : { start: at, end: at === null ? null : at + length }
  if (before.start === null || before.end === null) return null

  const start = changes.starts_at === undefined ? before.start : parseInstant(changes.starts_at)
  const end = changes.ends_at === undefined ? before.end : parseInstant(changes.ends_at)
  if (start === null || end === null || (sameSecond(start, before.start) && sameSecond(end, before.end))) return null

  const kept = changes.attendee_ids ? new Set(changes.attendee_ids) : null
  const guests = (state.guests.get((row ?? target).id) ?? []).filter((guest) => !kept || kept.has(guest.userId))
  return {
    startsAt: new Date(start).toISOString(),
    allDay: changes.all_day ?? (row ?? target).allDay,
    guests,
    everyone: changes.everyone ?? (master ?? target).everyone,
  }
}

function parts(date: Date, zone: string, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone }).formatToParts(date)
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).formatToParts(date)
  }
}

const pick = (list: Intl.DateTimeFormatPart[], type: string) => list.find((part) => part.type === type)?.value ?? ""

/** The day of a moment in a time zone as "Tue 3 Nov". A whole day is read in UTC */
export function dayTextIn(instant: string, zone: string, allDay = false): string {
  const date = new Date(instant)
  if (isNaN(date.getTime())) return instant
  const day = parts(date, allDay ? "UTC" : zone, { weekday: "short", day: "numeric", month: "short" })
  return `${pick(day, "weekday")} ${pick(day, "day")} ${pick(day, "month")}`
}

/** A moment in a time zone as "Tue 3 Nov 10:00", or "Tue 3 Nov" for a whole day */
export function whenIn(instant: string, zone: string, allDay = false): string {
  const date = new Date(instant)
  if (allDay || isNaN(date.getTime())) return dayTextIn(instant, zone, allDay)
  const time = parts(date, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  return `${dayTextIn(instant, zone)} ${pick(time, "hour")}:${pick(time, "minute")}`
}

/** The calendar day of a moment in a time zone, as YYYY-MM-DD */
export function dayIn(instant: string, zone: string, allDay = false): string {
  const date = new Date(instant)
  if (isNaN(date.getTime())) return instant.slice(0, 10)
  const list = parts(date, allDay ? "UTC" : zone, { year: "numeric", month: "2-digit", day: "2-digit" })
  return `${pick(list, "year")}-${pick(list, "month")}-${pick(list, "day")}`
}
