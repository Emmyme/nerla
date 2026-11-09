import type { EventType } from "@/lib/eventColors"
import { get, post, put, del } from "@/lib/api/request"
import type { TrashRef } from "@/lib/api/trash"
import type { Via } from "@/lib/api/ai"

export type EventResponse = "pending" | "yes" | "no" | "maybe"
export type RecurrenceScope = "this" | "following" | "all"
export type ReminderMinutes = 0 | 5 | 10 | 30 | 60 | 1440

export interface EventAttendee {
  user_id: string
  first_name: string | null
  last_name: string | null
  avatar_url: string | null
  response: EventResponse
}

export interface EventOrganizer {
  id: string
  first_name: string | null
  last_name: string | null
  avatar_url: string | null
}

/** One occurrence as the server shows it in full. `occurrence_id` is unique per occurrence, `id` is the row. */
export interface CalendarEvent {
  id: string
  occurrence_id: string
  series_id: string | null
  original_start: string | null
  title: string
  description: string | null
  location: string | null
  starts_at: string
  ends_at: string
  all_day: boolean
  event_type: EventType
  video_call: boolean
  everyone: boolean
  recurrence_rule: string | null
  recurrence_tz: string | null
  reminder_minutes: ReminderMinutes | null
  created_by: string
  organizer: EventOrganizer
  calendar_user_id: string
  attendees: EventAttendee[]
  viewer_response: EventResponse | null
  created_at: string
  updated_at: string
  busy?: undefined
  /** Made through the user's agent or AI */
  done_via?: Via | null
}

/** A teammate's event the viewer may only see as busy. `id` is opaque, per calendar and occurrence, and never names the event. */
export interface BusyEvent {
  id: string
  starts_at: string | null
  ends_at: string | null
  all_day: boolean
  calendar_user_id: string
  busy: true
  /** Out of office keeps its label when the rest is hidden */
  ooo?: true
}

export type CalendarEntry = CalendarEvent | BusyEvent

export interface EventCreateBody {
  title: string
  starts_at: string
  ends_at: string
  description?: string | null
  location?: string | null
  all_day?: boolean
  event_type?: EventType
  video_call?: boolean
  everyone?: boolean
  recurrence_rule?: string | null
  recurrence_tz?: string | null
  reminder_minutes?: ReminderMinutes | null
  attendee_ids?: string[]
}

/** Times belong to the occurrence named by `occurrence`. Send only what changed. */
export type EventPatch = Partial<EventCreateBody>

interface EventScope {
  scope?: RecurrenceScope
  /** The occurrence's `original_start` */
  occurrence?: string | null
}

export type ShareLevel = "details" | "busy" | "private"
export type GrantLevel = "busy" | "everything"

export interface CalendarSharing {
  default_level: ShareLevel
  grants: {
    grantee_id: string
    level: GrantLevel
    grantee: { id: string; first_name: string | null; last_name: string | null; avatar_url: string | null }
  }[]
}

function scopeQuery({ scope, occurrence }: EventScope = {}): string {
  const params = new URLSearchParams()
  if (scope) params.set("scope", scope)
  if (occurrence) params.set("occurrence", occurrence)
  const query = params.toString()
  return query ? `?${query}` : ""
}

function rangeQuery(start: string, end: string): string {
  return `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
}

export const calendarAPI = {
  /** The user's calendar between two instants, at most 120 days apart */
  getRange: async (start: string, end: string): Promise<CalendarEvent[]> => {
    return get(`/calendar/range?${rangeQuery(start, end)}`)
  },

  /** Team view for up to 20 users in one request. Users who do not share are left out. */
  getTeamRange: async (start: string, end: string, userIds: string[]): Promise<Record<string, CalendarEntry[]>> => {
    return get(`/calendar/team?${rangeQuery(start, end)}&users=${userIds.map(encodeURIComponent).join(",")}`)
  },

  createEvent: async (body: EventCreateBody): Promise<CalendarEvent> => {
    return post("/calendar", body)
  },

  updateEvent: async (eventId: string, patch: EventPatch, scope?: EventScope): Promise<CalendarEvent | { id: string }> => {
    return put(`/calendar/${eventId}${scopeQuery(scope)}`, patch)
  },

  /** Each scope makes one Trash entry, which restores as one */
  deleteEvent: (eventId: string, scope?: EventScope): Promise<TrashRef> =>
    del<{ trash: TrashRef }>(`/calendar/${eventId}${scopeQuery(scope)}`).then((reply) => reply.trash),

  restoreEvent: (entryId: string): Promise<CalendarEvent | { id: string }> => post(`/calendar/${entryId}/restore`),

  purgeEvent: (entryId: string): Promise<void> => del(`/calendar/${entryId}/forever`),

  respond: async (eventId: string, response: Exclude<EventResponse, "pending">): Promise<CalendarEvent> => {
    return post(`/calendar/${eventId}/respond`, { response })
  },
}

export const calendarSharingAPI = {
  get: async (): Promise<CalendarSharing> => {
    return get("/calendar/sharing")
  },

  /** Omitted parts stay. `grants` replaces the whole list. */
  save: async (body: { default_level?: ShareLevel; grants?: { grantee_id: string; level: GrantLevel }[] }): Promise<CalendarSharing> => {
    return put("/calendar/sharing", body)
  },
}
