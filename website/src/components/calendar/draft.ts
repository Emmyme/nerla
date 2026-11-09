import type { CalendarEvent, EventAttendee, EventCreateBody, EventPatch, ReminderMinutes } from "@/lib/api/calendar"
import {
  addDays,
  allDayRange,
  formatDayTitle,
  formatShortDate,
  formatTime,
  formatTimeRange,
  parseServerDate,
  sameDay,
  startOfDay,
} from "@/lib/dates"
import type { EventType } from "@/lib/eventColors"
import { NO_TITLE, OOO_TITLE } from "./items"
import { followStart, localTimeZone } from "./recurrence"

/**
 * An event on its way to being saved. Timed drafts hold instants. All-day drafts hold the local
 * midnights of the first and the last day, both included.
 */
export type EventDraft = {
  start: Date
  end: Date
  allDay: boolean
  title: string
  type: EventType
  video: boolean
  location: string
  description: string
  rule: string | null
  guests: EventAttendee[]
  everyone: boolean
  reminder: ReminderMinutes | null
  /** Set when the draft edits an existing event */
  event?: CalendarEvent
  /** The series' rule when the draft was opened, which an occurrence does not always carry */
  savedRule?: string | null
  /** Set once the user picks a repeat themselves, rather than it following the start */
  ruleTouched?: boolean
}

const DEFAULT_REMINDER: ReminderMinutes = 10
const COPY_SUFFIX = " (copy)"

const utcMidnight = (day: Date) => new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())).toISOString()

export function newDraft(start: Date, end: Date, allDay: boolean, fields: Partial<EventDraft> = {}): EventDraft {
  return {
    start,
    end,
    allDay,
    title: "",
    type: "event",
    video: false,
    location: "",
    description: "",
    rule: null,
    guests: [],
    everyone: false,
    reminder: DEFAULT_REMINDER,
    ...fields,
  }
}

export function draftFromEvent(event: CalendarEvent, rule: string | null = event.recurrence_rule): EventDraft {
  const range = allDayRange(event)
  const start = event.all_day ? (range?.first ?? new Date()) : (parseServerDate(event.starts_at) ?? new Date())
  const end = event.all_day ? (range?.last ?? start) : (parseServerDate(event.ends_at) ?? start)
  return {
    start,
    end,
    allDay: event.all_day,
    title: event.title === NO_TITLE || (event.event_type === "ooo" && event.title === OOO_TITLE) ? "" : event.title,
    type: event.event_type,
    video: event.video_call,
    location: event.location ?? "",
    description: event.description ?? "",
    rule,
    guests: event.attendees,
    everyone: event.everyone,
    reminder: event.reminder_minutes,
    event,
    savedRule: rule,
  }
}

/** A new event with the same details, and the copier no longer a guest of their own copy */
export function duplicateDraft(event: CalendarEvent, rule: string | null, userId: string | undefined): EventDraft {
  const { event: _source, savedRule: _rule, ...copy } = draftFromEvent(event, rule)
  return {
    ...copy,
    title: copy.title ? `${copy.title}${COPY_SUFFIX}` : "",
    guests: copy.guests.filter((guest) => guest.user_id !== userId).map((guest) => ({ ...guest, response: "pending" })),
  }
}

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/** Whole days from a draft's first day to its last */
export const draftDays = (draft: Pick<EventDraft, "start" | "end">) =>
  Math.round((startOfDay(draft.end).getTime() - startOfDay(draft.start).getTime()) / DAY_MS)

/** All day keeps the dates. Back to timed, it starts at 09:00 for half an hour. */
export function withAllDay(draft: EventDraft, allDay: boolean): EventDraft {
  if (allDay)
    return {
      ...draft,
      allDay,
      start: startOfDay(draft.start),
      end: startOfDay(new Date(Math.max(draft.start.getTime(), draft.end.getTime() - 1))),
    }
  const start = new Date(draft.start.getFullYear(), draft.start.getMonth(), draft.start.getDate(), 9)
  return { ...draft, allDay, start, end: new Date(start.getTime() + 30 * MINUTE_MS) }
}

/**
 * True when an edited occurrence's rule changed only because its start moved, as "Weekly on Friday"
 * following it to Monday. "This event" can then move just the one occurrence and leave the rule.
 */
export function ruleFollowsOnly(draft: EventDraft): boolean {
  const { event } = draft
  if (!event || draft.ruleTouched) return false
  const saved = draft.savedRule === undefined ? event.recurrence_rule : draft.savedRule
  if (draft.rule === saved) return false
  return draft.rule === followStart(saved, draftFromEvent(event, saved).start, draft.start)
}

/** The stored times: UTC instants, all-day as 00:00 UTC of the first day to 00:00 UTC of the day after the last */
export function draftTimes(draft: Pick<EventDraft, "start" | "end" | "allDay">): { starts_at: string; ends_at: string; all_day: boolean } {
  if (draft.allDay) return { starts_at: utcMidnight(draft.start), ends_at: utcMidnight(addDays(draft.end, 1)), all_day: true }
  return { starts_at: draft.start.toISOString(), ends_at: draft.end.toISOString(), all_day: false }
}

const guestIds = (guests: { user_id: string }[]) => guests.map((guest) => guest.user_id).sort()

/** The title as saved: out of office may go without one */
export const draftTitle = (draft: Pick<EventDraft, "title" | "type">) => draft.title.trim() || (draft.type === "ooo" ? OOO_TITLE : NO_TITLE)

export function draftBody(draft: EventDraft): EventCreateBody {
  // The server needs a title, so an empty one is saved as Google does
  const body: EventCreateBody = {
    title: draftTitle(draft),
    ...draftTimes(draft),
    event_type: draft.type,
    video_call: draft.video,
    everyone: draft.everyone,
    reminder_minutes: draft.reminder,
  }
  if (draft.location.trim()) body.location = draft.location.trim()
  if (draft.description.trim()) body.description = draft.description.trim()
  if (draft.guests.length) body.attendee_ids = guestIds(draft.guests)
  if (draft.rule) {
    body.recurrence_rule = draft.rule
    body.recurrence_tz = localTimeZone()
  }
  return body
}

const sameInstant = (a: string | null, b: string | null) => (parseServerDate(a)?.getTime() ?? 0) === (parseServerDate(b)?.getTime() ?? 0)

/** Only the fields that changed, as the server wants them. The zone goes along only with a new rule. */
export function draftPatch(draft: EventDraft, event: CalendarEvent): EventPatch {
  const patch: EventPatch = {}
  const body = draftBody(draft)
  if (body.title !== event.title) patch.title = body.title
  if (draft.type !== event.event_type) patch.event_type = draft.type
  if (draft.video !== event.video_call) patch.video_call = draft.video
  if (draft.everyone !== event.everyone) patch.everyone = draft.everyone
  if (draft.reminder !== event.reminder_minutes) patch.reminder_minutes = draft.reminder
  if ((body.location ?? null) !== (event.location ?? null)) patch.location = body.location ?? null
  if ((body.description ?? null) !== (event.description ?? null)) patch.description = body.description ?? null
  if (guestIds(draft.guests).join(",") !== guestIds(event.attendees).join(",")) patch.attendee_ids = guestIds(draft.guests)
  if (draft.allDay !== event.all_day) patch.all_day = draft.allDay
  if (!sameInstant(body.starts_at, event.starts_at) || patch.all_day !== undefined) patch.starts_at = body.starts_at
  if (!sameInstant(body.ends_at, event.ends_at) || patch.all_day !== undefined) patch.ends_at = body.ends_at
  const saved = draft.savedRule === undefined ? event.recurrence_rule : draft.savedRule
  if (draft.rule !== saved) {
    patch.recurrence_rule = draft.rule
    if (draft.rule) patch.recurrence_tz = body.recurrence_tz
  }
  return patch
}

/** Whether a draft differs from how it was opened, as it would be saved */
export function draftChanged(draft: EventDraft, opened: EventDraft): boolean {
  return JSON.stringify(draftBody(draft)) !== JSON.stringify(draftBody(opened))
}

export type DraftErrors = { title?: string; end?: string }

/** The full editor needs a title, except for out of office. A timed event may run past midnight, as long as it ends after it starts. */
export function draftErrors(draft: EventDraft): DraftErrors {
  const errors: DraftErrors = {}
  if (!draft.title.trim() && draft.type !== "ooo") errors.title = "Add a title"
  if (draft.allDay ? draft.end < draft.start : draft.end <= draft.start) errors.end = "End must be after start"
  return errors
}

/** "Thursday 23 October, 09:00 to 09:30", or the dates when it runs over several days */
export function draftSummary(draft: Pick<EventDraft, "start" | "end" | "allDay">): string {
  const { start, end, allDay } = draft
  if (allDay)
    return sameDay(start, end) ? `${formatDayTitle(start)}, all day` : `${formatShortDate(start)} to ${formatShortDate(end)}, all day`
  if (sameDay(start, new Date(end.getTime() - 1))) return `${formatDayTitle(start)}, ${formatTimeRange(start, end)}`
  return `${formatShortDate(start)} ${formatTime(start)} to ${formatShortDate(end)} ${formatTime(end)}`
}

const pad = (n: number) => String(n).padStart(2, "0")

/** "09:30", the value of a time input */
export const timeValue = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`

/** The local time "HH:MM" on a day */
export function atTime(day: Date, value: string): Date | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(match[1]), Number(match[2]))
}
