import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { calendarEvents, db } from "../../db"
import type { EventDto } from "../../utils/eventDto"
import { allDayBounds, DAY_MS, InstantError, isValidTimeZone, storedMs } from "../../utils/eventTime"
import { teammatesSeeDetails, type BusyDto } from "../../utils/eventVisibility"
import { eventChangeRecipients } from "../../utils/eventNotice"
import { describeRecurrence } from "../../utils/recurrence"
import { getSharing, type FreeAnswer } from "../calendarQueries"
import { FREE_MAX_DAYS, FREE_MAX_MINUTES, FREE_MAX_PEOPLE, FREE_MIN_MINUTES } from "../../utils/freeSlots"
import { EVENT_TYPES, timeOfDaySchema } from "../../validation/schemas"
import { AppError } from "../acting"
import {
  call,
  clip,
  joinNames,
  LIST_LIMIT,
  nameOf,
  namesOf,
  ownTimeZone,
  query,
  toInstant,
  tool,
  uuid,
  whenText,
  type ToolContext,
} from "./shared"

type Visible = EventDto | BusyDto

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_OR_ZONED =
  "ISO 8601 date and time. A local time such as 2026-10-30T15:00 is read in the user's time zone, or add Z or an offset"

const eventRef = (id: string) => ({ kind: "event" as const, id })

const isFull = (event: Visible): event is EventDto => !("busy" in event)

const eventItem = (event: EventDto) => ({
  ref: eventRef(event.id),
  id: event.id,
  title: event.title,
  starts_at: event.starts_at,
  ends_at: event.ends_at,
  all_day: event.all_day,
  type: event.event_type,
  location: event.location,
  description: event.description,
  video_call: event.video_call,
  repeats: !!event.recurrence_rule,
  organizer: nameOf(event.organizer),
  organizer_id: event.created_by,
  attendees: event.attendees.map((attendee) => ({ id: attendee.user_id, name: nameOf(attendee), response: attendee.response })),
})

/**
 * Who may have written the text the AI reads about an event: its creator, each attendee, whose name is shown, and
 * an unknown author once the event has been edited, since a workspace admin can edit any event
 */
const eventAuthors = (event: EventDto): (string | null)[] => [
  event.created_by,
  ...event.attendees.map((attendee) => attendee.user_id),
  ...(event.updated_at !== event.created_at ? [null] : []),
]

/** Names for the users a call would invite, so the card says exactly who */
async function inviteeNames(ctx: ToolContext, ids: string[]): Promise<string[]> {
  const others = [...new Set(ids)].filter((id) => id !== ctx.askerId)
  const names = await namesOf(ctx, others)
  return others.map((id) => names.get(id) ?? "someone outside the workspace")
}

/** How a card names each kind of event */
const TYPE_WORDS: Record<(typeof EVENT_TYPES)[number], string> = {
  meeting: "event",
  event: "event",
  task: "task block",
  focus: "focus time",
  personal: "personal event",
  ooo: "out of office",
}

const listEvents = tool({
  name: "list_events",
  area: "calendar",
  write: false,
  description: "List the user's calendar events, invitations and Everyone events in a time range, the next 7 days unless given.",
  input: z.object({
    start: z.string().max(40).optional().describe(LOCAL_OR_ZONED),
    end: z.string().max(40).optional().describe(`${LOCAL_OR_ZONED}. At most 120 days after start`),
  }),
  async run(ctx, args) {
    const zone = args.start || args.end ? await ownTimeZone(ctx) : "UTC"
    const bound = (value: string) => toInstant(DATE_ONLY.test(value) ? `${value}T00:00` : value, zone)
    const start = args.start ? bound(args.start) : new Date().toISOString()
    const from = new Date(start).getTime()
    const end = args.end ? bound(args.end) : new Date((isNaN(from) ? Date.now() : from) + 7 * DAY_MS).toISOString()
    const rows = await call<Visible[]>(ctx, { method: "GET", url: `/api/calendar/range?${query({ start, end })}` })
    const shown = rows.filter(isFull).slice(0, LIST_LIMIT)
    return { ok: true, data: null, items: shown.map(eventItem), authors: shown.flatMap(eventAuthors) }
  },
})

const timeOfDay = (fallback: string) =>
  timeOfDaySchema.optional().describe(`A time of day as HH:MM in the time zone. Defaults to the user's working hours, else ${fallback}`)

/** A day and time in a zone, as "Tue 3 Nov 10:00" */
function localText(instant: string, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant))
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return `${pick("weekday")} ${pick("day")} ${pick("month")} ${pick("hour")}:${pick("minute")}`
}

const NO_TIME = "No time works for everyone in that window. Suggest a longer window, a shorter meeting, other times of day or fewer people."

const findTime = tool({
  name: "find_time",
  area: "calendar",
  write: false,
  ownView: true,
  description:
    "Find up to 5 times when the user and the given workspace members are all free and inside their working hours, from free and busy only. It gives times, never what anyone is doing. Offer the times to the user and book the one they pick with create_event.",
  input: z.object({
    attendee_ids: z.array(uuid).min(1).max(FREE_MAX_PEOPLE).describe("The workspace members to meet. The user is always included"),
    minutes: z.number().int().min(FREE_MIN_MINUTES).max(FREE_MAX_MINUTES).describe("How long the meeting is, in minutes"),
    from: z.string().max(40).optional().describe(`${LOCAL_OR_ZONED}, or YYYY-MM-DD. Defaults to now`),
    to: z
      .string()
      .max(40)
      .optional()
      .describe(
        `${LOCAL_OR_ZONED}, or YYYY-MM-DD for the end of that day. Defaults to the end of the user's next 5 working days, at most ${FREE_MAX_DAYS} days after from`,
      ),
    earliest: timeOfDay("09:00"),
    latest: timeOfDay("17:00"),
    time_zone: z
      .string()
      .max(64)
      .refine(isValidTimeZone, { message: "Use an IANA time zone such as Europe/Stockholm" })
      .optional()
      .describe("The IANA time zone that times are read and given in. Defaults to the user's own"),
  }),
  async run(ctx, args) {
    const zone = args.time_zone ?? (await ownTimeZone(ctx))
    const dayAfter = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)
    const start = args.from && toInstant(DATE_ONLY.test(args.from) ? `${args.from}T00:00` : args.from, zone)
    const end = args.to && toInstant(DATE_ONLY.test(args.to) ? `${dayAfter(args.to)}T00:00` : args.to, zone)
    const found = await call<FreeAnswer>(ctx, {
      method: "GET",
      url: `/api/calendar/free?${query({
        users: args.attendee_ids.join(","),
        start,
        end,
        minutes: args.minutes,
        day_start: args.earliest,
        day_end: args.latest,
        time_zone: zone,
      })}`,
    })
    const names = await namesOf(
      ctx,
      found.people.map((person) => person.id),
    )
    return {
      ok: true,
      data: {
        time_zone: zone,
        slots: found.slots.map((slot) => ({ ...slot, when: localText(slot.starts_at, zone) })),
        people: found.people.map((person) => ({
          name: person.id === ctx.askerId ? "the user" : (names.get(person.id) ?? "a teammate"),
          calendar:
            person.calendar === "shared" ? "shared" : "not shared with the user, so only their working hours and out of office are known",
          working_hours: person.working_hours ? "set" : "not set, so the user's day is used",
        })),
        ...(found.slots.length ? {} : { note: NO_TIME }),
      },
      // Each name was written by its user
      authors: found.people.map((person) => person.id),
    }
  },
})

const createEvent = tool({
  name: "create_event",
  area: "calendar",
  write: true,
  alwaysGated: (args) => (args.attendee_ids?.length ?? 0) > 0,
  description: "Create a calendar event for the user, optionally repeating and optionally inviting workspace members.",
  input: z.object({
    title: z.string().trim().min(1).max(255),
    start: z.string().max(40).describe(`${LOCAL_OR_ZONED}. YYYY-MM-DD for an all-day event`),
    end: z.string().max(40).describe(`${LOCAL_OR_ZONED}. YYYY-MM-DD for an all-day event, its last day`),
    all_day: z.boolean().optional(),
    type: z
      .enum(EVENT_TYPES)
      .optional()
      .describe(
        "meeting by default. focus for focus time, ooo for out of office, personal, task for time blocked for a task, event for anything else",
      ),
    description: z.string().max(10000).optional(),
    video_call: z.boolean().optional(),
    attendee_ids: z.array(uuid).max(50).optional().describe("Workspace members to invite"),
    repeat: z
      .string()
      .max(500)
      .refine((rule) => describeRecurrence(rule) !== null, {
        message:
          "The calendar can't repeat that way. Use FREQ daily, weekly, monthly or yearly with INTERVAL, BYDAY, BYMONTHDAY, COUNT or UNTIL",
      })
      .optional()
      .describe("An RFC 5545 RRULE without DTSTART, such as FREQ=WEEKLY;BYDAY=MO,WE or FREQ=MONTHLY;BYDAY=-1FR;COUNT=6"),
    time_zone: z
      .string()
      .max(64)
      .refine(isValidTimeZone, { message: "Use an IANA time zone such as Europe/Stockholm" })
      .optional()
      .describe(
        "The IANA time zone, such as Europe/Stockholm, that local times are read in and a repeating event keeps its time in. Defaults to the user's own",
      ),
  }),
  async run(ctx, args) {
    const times = await eventTimes(ctx, args)
    if ("error" in times) return { ok: false, error: times.error }
    const event = await call<EventDto>(ctx, {
      method: "POST",
      url: "/api/calendar",
      body: {
        title: args.title,
        starts_at: times.start,
        ends_at: times.end,
        all_day: times.allDay || undefined,
        event_type: args.type,
        description: args.description,
        video_call: args.video_call ?? false,
        attendee_ids: args.attendee_ids,
        recurrence_rule: args.repeat,
        recurrence_tz: args.repeat && !times.allDay ? times.zone : undefined,
      },
    })
    return {
      ok: true,
      data: { id: event.id, title: event.title, starts_at: event.starts_at, ends_at: event.ends_at },
      authors: [],
      target: eventRef(event.id),
    }
  },
  async othersCanSee(ctx, args) {
    if ((args.attendee_ids ?? []).some((id) => id !== ctx.askerId)) return true
    try {
      return teammatesSeeDetails(await getSharing(ctx.askerId, ctx.organizationId), "meeting")
    } catch {
      return true
    }
  },
  async summary(args, ctx) {
    const names = await inviteeNames(ctx, args.attendee_ids ?? [])
    const times = await eventTimes(ctx, args)
    const when = "error" in times ? args.start : await whenText(ctx, times.start, times.allDay)
    const repeats = args.repeat ? `, ${describeRecurrence(args.repeat) ?? "repeating"}` : ""
    return `Create ${TYPE_WORDS[args.type ?? "meeting"]} ${clip(args.title)}, ${when}${repeats}${names.length ? ` and invite ${joinNames(names)}` : ""}`
  },
})

type EventTimes = { start: string; end: string; allDay: boolean; zone: string } | { error: string }

/** An event's start and end as instants. Two dates make an all-day event, with the end as its last day */
export async function eventTimes(
  ctx: ToolContext,
  args: { start: string; end: string; all_day?: boolean; time_zone?: string },
): Promise<EventTimes> {
  const zone = args.time_zone ?? (await ownTimeZone(ctx))
  if (DATE_ONLY.test(args.start) && DATE_ONLY.test(args.end)) {
    try {
      const bounds = allDayBounds(args.start, args.end)
      return { start: bounds.starts_at, end: bounds.ends_at, allDay: true, zone }
    } catch (error) {
      if (error instanceof InstantError) return { error: error.message }
      throw error
    }
  }
  const allDay = !!args.all_day
  const readIn = allDay ? "UTC" : zone
  return { start: toInstant(args.start, readIn), end: toInstant(args.end, readIn), allDay, zone }
}

/** The asker's own event. Another user's answers like one that doesn't exist */
async function ownEvent(ctx: ToolContext, eventId: string): Promise<EventDto> {
  const event = await call<Visible>(ctx, { method: "GET", url: `/api/calendar/${eventId}` })
  if (!isFull(event) || event.created_by !== ctx.askerId) throw new AppError(404, "Event not found")
  return event
}

const inviteToEvent = tool({
  name: "invite_to_event",
  area: "calendar",
  write: true,
  alwaysGated: () => true,
  description: "Invite workspace members to an event the user created.",
  input: z.object({
    eventId: uuid,
    attendee_ids: z.array(uuid).min(1).max(50).describe("Workspace members to add as guests"),
  }),
  async run(ctx, args) {
    const event = await ownEvent(ctx, args.eventId)
    if (event.everyone) return { ok: false, error: "An Everyone event can't take invites" }
    const attending = new Set(event.attendees.map((attendee) => attendee.user_id))
    if (!args.attendee_ids.some((id) => id !== ctx.askerId && !attending.has(id))) return { ok: false, error: "Nobody new to invite" }
    const guests = [...new Set([...event.attendees.map((attendee) => attendee.user_id), ...args.attendee_ids])]
    const updated = await call<EventDto>(ctx, { method: "PUT", url: `/api/calendar/${event.id}`, body: { attendee_ids: guests } })
    return {
      ok: true,
      data: { id: updated.id, title: updated.title, attendees: updated.attendees?.map((attendee) => nameOf(attendee)) ?? [] },
      authors: updated.attendees?.map((attendee) => attendee.user_id) ?? [],
      target: eventRef(event.id),
    }
  },
  async othersCanSee() {
    return true
  },
  async summary(args, ctx) {
    const invitees = await inviteeNames(ctx, args.attendee_ids)
    const names = joinNames(invitees)
    try {
      const event = await ownEvent(ctx, args.eventId)
      if (invitees.length === 0) return `Nobody new to invite to ${clip(event.title)}`
      return `Invite ${names} to ${clip(event.title)}, ${await whenText(ctx, event.starts_at ?? "", event.all_day)}`
    } catch {
      return invitees.length ? `Invite ${names} to an event` : "Nobody new to invite"
    }
  },
})

type MoveArgs = {
  eventId: string
  start: string
  end?: string
  time_zone?: string
  scope?: "this" | "following" | "all"
  occurrence?: string
}
/** The event named, the row that moves (an occurrence changed on its own has its own), and the times */
type Move = { named: EventDto; row: EventDto; from: string; start: string; end: string; occurrence?: string }

const SCOPE_WORDS = { this: "this occurrence only", following: "this and following occurrences", all: "every occurrence" } as const
const midnight = (date: string) => `${date}T00:00:00.000Z`

/** A repeating event needs to know which occurrences move, never a guess */
function scopeRefusal(event: EventDto, args: MoveArgs): string | null {
  if (!event.recurrence_rule) return null
  if (!args.scope || !args.occurrence) {
    return "This event repeats. Ask the user which occurrence to move, and whether to move only that one, it and the ones after, or every occurrence. Give that occurrence's start from list_events"
  }
  return null
}

/** The occurrence of a series at `at` that was changed on its own, if any */
async function overrideAt(ctx: ToolContext, seriesId: string, at: number) {
  // trash: a cancelled occurrence, in Trash or not, still answers that it was cancelled
  const rows = await db
    .select({ id: calendarEvents.id, originalStart: calendarEvents.originalStart, cancelled: calendarEvents.cancelled })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.seriesId, seriesId), eq(calendarEvents.organizationId, ctx.organizationId)))
  return rows.find((row) => Math.floor((storedMs(row.originalStart) ?? NaN) / 1000) === Math.floor(at / 1000))
}

/** Where the event is now and where it goes. Without an end it keeps its length */
async function planMove(ctx: ToolContext, args: MoveArgs): Promise<Move | { error: string }> {
  const named = await ownEvent(ctx, args.eventId)
  const refusal = scopeRefusal(named, args)
  if (refusal) return { error: refusal }
  const zone = args.time_zone ?? (await ownTimeZone(ctx))
  const readIn = named.all_day ? "UTC" : zone
  const instant = (value: string) => (DATE_ONLY.test(value) ? (named.all_day ? midnight(value) : null) : toInstant(value, readIn))
  const occurrence = named.recurrence_rule && args.occurrence !== undefined ? instant(args.occurrence) : undefined
  const start = instant(args.start)
  const end = args.end === undefined ? undefined : instant(args.end)
  if (occurrence === null || start === null || end === null)
    return { error: "Give a time as well as the date, since this event isn't all day" }
  const at = occurrence === undefined ? NaN : Date.parse(occurrence)
  if (occurrence !== undefined && isNaN(at)) return { error: `Give occurrence as an ${LOCAL_OR_ZONED}` }

  const own = occurrence === undefined ? undefined : await overrideAt(ctx, named.id, at)
  if (own?.cancelled) return { error: "That occurrence was cancelled, so there's nothing to move" }
  const row = own ? await ownEvent(ctx, own.id) : named
  const length = Date.parse(row.ends_at ?? "") - Date.parse(row.starts_at ?? "")
  const begin = Date.parse(start)
  if (isNaN(begin) || isNaN(length)) return { error: `Give start as an ${LOCAL_OR_ZONED}` }
  const finish = end === undefined ? begin + length : Date.parse(end) + (named.all_day && args.end && DATE_ONLY.test(args.end) ? DAY_MS : 0)
  if (isNaN(finish)) return { error: `Give end as an ${LOCAL_OR_ZONED}` }
  if (finish <= begin) return { error: "The end has to be after the start" }
  return {
    named,
    row,
    from: own ? (row.starts_at ?? start) : (occurrence ?? row.starts_at ?? start),
    start: new Date(begin).toISOString(),
    end: new Date(finish).toISOString(),
    occurrence: own ? undefined : occurrence,
  }
}

/** One lookup per call while it is checked and held. A later call, or the run after Allow, looks again */
const planned = new WeakMap<object, Promise<Move | { error: string }>>()
function checkedMove(ctx: ToolContext, args: MoveArgs): Promise<Move | { error: string }> {
  if (!planned.has(args)) planned.set(args, planMove(ctx, args))
  return planned.get(args)!
}

async function movedOrThrow(ctx: ToolContext, args: MoveArgs): Promise<Move> {
  const move = await checkedMove(ctx, args)
  if ("error" in move) throw new AppError(400, move.error)
  return move
}

const othersIn = (event: EventDto, askerId: string) => event.attendees.filter((attendee) => attendee.user_id !== askerId)

/** Guests of the occurrence that moves and of its series */
const guestsOf = (move: Move, askerId: string) => [...othersIn(move.row, askerId), ...othersIn(move.named, askerId)]

/** Who a change to the event tells, by name: its guests who haven't declined, and its organiser when that isn't the asker */
function toldNames(event: EventDto, askerId: string): string[] {
  const told = eventChangeRecipients(
    event.attendees.map((attendee) => ({ userId: attendee.user_id, response: attendee.response })),
    askerId,
    event.everyone,
    event.created_by,
  )
  return [
    ...event.attendees.filter((attendee) => told.includes(attendee.user_id)).map((attendee) => nameOf(attendee) ?? "a teammate"),
    ...(told.includes(event.created_by) && !event.attendees.some((attendee) => attendee.user_id === event.created_by)
      ? [nameOf(event.organizer) ?? "the organiser"]
      : []),
  ]
}

const moveEvent = tool({
  name: "move_event",
  area: "calendar",
  write: true,
  description:
    "Move an event the user organises to a new time. It keeps its length unless end is given. For a repeating event give scope and the occurrence. Guests who haven't declined are told.",
  input: z.object({
    eventId: uuid,
    start: z.string().max(40).describe(`The new start. ${LOCAL_OR_ZONED}. YYYY-MM-DD for an all-day event`),
    end: z
      .string()
      .max(40)
      .optional()
      .describe(`The new end. ${LOCAL_OR_ZONED}. YYYY-MM-DD for an all-day event, its last day. Leave it out to keep the length`),
    time_zone: z
      .string()
      .max(64)
      .refine(isValidTimeZone, { message: "Use an IANA time zone such as Europe/Stockholm" })
      .optional()
      .describe("The IANA time zone local times are read in. Defaults to the user's own"),
    scope: z.enum(["this", "following", "all"]).optional().describe("For a repeating event: this occurrence, this and following, or all"),
    occurrence: z
      .string()
      .max(40)
      .optional()
      .describe("For a repeating event, the start of the occurrence to move, as list_events gives it"),
  }),
  alwaysGated: async (args, ctx) => guestsOf(await movedOrThrow(ctx, args), ctx.askerId).length > 0,
  async precheck(ctx, args) {
    const move = await checkedMove(ctx, args)
    return "error" in move ? move.error : null
  },
  async run(ctx, args) {
    const move = await planMove(ctx, args)
    if ("error" in move) return { ok: false, error: move.error }
    const { row } = move
    const repeats = !!row.recurrence_rule || !!row.series_id
    const scope = repeats ? query({ scope: args.scope, occurrence: move.occurrence }) : ""
    const moved = await call<EventDto>(ctx, {
      method: "PUT",
      url: `/api/calendar/${row.id}${scope ? `?${scope}` : ""}`,
      body: { starts_at: move.start, ends_at: move.end },
    })
    return {
      ok: true,
      data: { id: moved.id, title: moved.title, starts_at: moved.starts_at, ends_at: moved.ends_at },
      authors: eventAuthors(row),
      target: eventRef(moved.id),
    }
  },
  async othersCanSee(ctx, args) {
    const move = await movedOrThrow(ctx, args)
    if (move.named.everyone || move.row.everyone || guestsOf(move, ctx.askerId).length > 0) return true
    return teammatesSeeDetails(await getSharing(ctx.askerId, ctx.organizationId), move.row.event_type)
  },
  async summary(args, ctx) {
    const move = await movedOrThrow(ctx, args)
    const { row } = move
    const from = await whenText(ctx, move.from, row.all_day)
    const to = await whenText(ctx, move.start, row.all_day)
    const which = move.named.recurrence_rule && args.scope ? `, ${SCOPE_WORDS[args.scope]}` : ""
    const names = toldNames(row, ctx.askerId)
    return `Move ${clip(row.title)} from ${from} to ${to}${which}${names.length ? `. ${joinNames(names)} will be told` : ""}`
  },
})

type CancelArgs = { eventId: string; scope?: "this" | "following" | "all"; occurrence?: string }
/** The event named, the row the guests are read from, and the occurrence as an instant */
type Cancel = { named: EventDto; row: EventDto; at: string; occurrence?: string }

/** Which occurrences go, never a guess, and the occurrence as an instant the route reads */
async function planCancel(ctx: ToolContext, args: CancelArgs): Promise<Cancel | { error: string }> {
  const named = await ownEvent(ctx, args.eventId)
  if (!named.recurrence_rule) return { named, row: named, at: named.starts_at ?? "" }
  if (!args.scope || (args.scope !== "all" && !args.occurrence)) {
    return {
      error:
        "This event repeats. Ask the user whether to cancel only one occurrence, it and the ones after, or every occurrence, and which occurrence. Give that occurrence's start from list_events",
    }
  }
  if (args.scope === "all" || !args.occurrence) return { named, row: named, at: named.starts_at ?? "" }
  const zone = named.all_day ? "UTC" : await ownTimeZone(ctx)
  const occurrence = DATE_ONLY.test(args.occurrence) ? (named.all_day ? midnight(args.occurrence) : null) : toInstant(args.occurrence, zone)
  if (occurrence === null) return { error: "Give the occurrence's time as well as its date, since this event isn't all day" }
  const at = Date.parse(occurrence)
  if (isNaN(at)) return { error: `Give occurrence as an ${LOCAL_OR_ZONED}` }
  const own = await overrideAt(ctx, named.id, at)
  if (own?.cancelled) return { error: "That occurrence was already cancelled" }
  const row = own ? await ownEvent(ctx, own.id) : named
  return { named, row, at: own ? (row.starts_at ?? occurrence) : new Date(at).toISOString(), occurrence: new Date(at).toISOString() }
}

const cancels = new WeakMap<object, Promise<Cancel | { error: string }>>()
function checkedCancel(ctx: ToolContext, args: CancelArgs): Promise<Cancel | { error: string }> {
  if (!cancels.has(args)) cancels.set(args, planCancel(ctx, args))
  return cancels.get(args)!
}

const cancelEvent = tool({
  name: "cancel_event",
  area: "calendar",
  write: true,
  alwaysGated: () => true,
  description:
    "Cancel an event the user organises. It moves to the trash, where it can be restored for 30 days, and guests who haven't declined are told. For a repeating event give scope, and the occurrence unless the scope is all. It always waits for the user's Allow.",
  input: z.object({
    eventId: uuid,
    scope: z.enum(["this", "following", "all"]).optional().describe("For a repeating event: this occurrence, this and following, or all"),
    occurrence: z
      .string()
      .max(40)
      .optional()
      .describe("For a repeating event, the start of the occurrence to cancel, as list_events gives it"),
  }),
  async precheck(ctx, args) {
    const cancel = await checkedCancel(ctx, args)
    return "error" in cancel ? cancel.error : null
  },
  async run(ctx, args) {
    const cancel = await planCancel(ctx, args)
    if ("error" in cancel) return { ok: false, error: cancel.error }
    const { named } = cancel
    const scope = named.recurrence_rule ? query({ scope: args.scope, occurrence: cancel.occurrence }) : ""
    await call(ctx, { method: "DELETE", url: `/api/calendar/${named.id}${scope ? `?${scope}` : ""}` })
    return {
      ok: true,
      data: { id: named.id, title: named.title, cancelled: true, in_trash: true },
      authors: eventAuthors(named),
      target: eventRef(named.id),
    }
  },
  async summary(args, ctx) {
    const cancel = await checkedCancel(ctx, args)
    if ("error" in cancel) throw new AppError(400, cancel.error)
    const { named, row } = cancel
    const when = cancel.at ? `, ${await whenText(ctx, cancel.at, row.all_day)}` : ""
    const which = named.recurrence_rule && args.scope ? ` (${SCOPE_WORDS[args.scope]})` : ""
    const names = toldNames(row, ctx.askerId)
    return `Cancel ${clip(row.title)}${when}${which}${names.length ? `. ${joinNames(names)} will be told` : ""}`
  },
})

export const CALENDAR_TOOLS = [listEvents, findTime, createEvent, inviteToEvent, moveEvent, cancelEvent]
