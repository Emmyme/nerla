import type { calendarEvents } from "../db/schema"
import { readInstant } from "./eventTime"
import { redact, type BusyDto, type Visibility } from "./eventVisibility"
import { occurrenceFieldsOf, type OccurrenceFields } from "./recurrence"

type EventRow = typeof calendarEvents.$inferSelect

export type AttendeeInput = {
  userId: string
  response: string
  firstName: string | null
  lastName: string | null
  avatarUrl: string | null
}

export type PersonInput = { id: string; firstName: string | null; lastName: string | null; avatarUrl: string | null }

type EventDtoExtras = {
  /** The user whose calendar the row is shown on: the viewer in My calendar, the teammate in Team view. */
  calendarUserId: string
  attendees?: AttendeeInput[]
  viewerResponse?: string | null
  /** The creator's name and avatar. Without it the organizer carries only the id. */
  organizer?: PersonInput
}

export function toEventDto(
  row: EventRow | (EventRow & OccurrenceFields),
  { calendarUserId, attendees = [], viewerResponse = null, organizer }: EventDtoExtras,
) {
  const occurrence = "occurrence_id" in row ? row : occurrenceFieldsOf(row)
  return {
    id: row.id,
    occurrence_id: occurrence.occurrence_id,
    series_id: occurrence.series_id,
    original_start: occurrence.original_start,
    title: row.title,
    description: row.description,
    location: row.location,
    starts_at: readInstant(row.startsAt),
    ends_at: readInstant(row.endsAt),
    all_day: row.allDay,
    event_type: row.eventType,
    video_call: row.videoCall,
    everyone: row.everyone,
    recurrence_rule: row.recurrenceRule,
    recurrence_tz: row.recurrenceTz,
    reminder_minutes: row.reminderMinutes,
    created_by: row.createdBy,
    done_via: row.doneVia ?? null,
    organizer: {
      id: row.createdBy,
      first_name: organizer?.firstName ?? null,
      last_name: organizer?.lastName ?? null,
      avatar_url: organizer?.avatarUrl ?? null,
    },
    calendar_user_id: calendarUserId,
    attendees: attendees.map((attendee) => ({
      user_id: attendee.userId,
      first_name: attendee.firstName,
      last_name: attendee.lastName,
      avatar_url: attendee.avatarUrl,
      response: attendee.response,
    })),
    viewer_response: viewerResponse,
    created_at: readInstant(row.createdAt),
    updated_at: readInstant(row.updatedAt),
  }
}

export type EventDto = ReturnType<typeof toEventDto>

/** The one way an event leaves the server: in full, as a busy block, or not at all. */
export function toVisibleEventDto(
  row: EventRow | (EventRow & OccurrenceFields),
  visibility: Visibility,
  extras: EventDtoExtras,
): EventDto | BusyDto | null {
  if (visibility === "hidden") return null
  if (visibility === "full") return toEventDto(row, extras)
  return redact(toEventDto(row, { calendarUserId: extras.calendarUserId }))
}
