import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { markedVia } from "@/components/ai/via"
import { ViaMark } from "@/components/ai/ViaMark"
import { Link as RouterLink } from "react-router"
import { toast } from "sonner"
import { FileGlyph } from "@/components/files/FileList"
import { Bell, Calendar, Copy, Link, MapPin, Paper, Pencil, Repeat, TextLeft, Trash, Users, Video, X } from "@/components/icons"
import { AnchoredPopover, type PopoverSide } from "@/components/ui/anchored-popover"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { UserAvatar } from "@/components/ui/user-avatar"
import { papersAPI } from "@/lib/api/papers"
import type { CalendarEvent, EventAttendee, EventResponse } from "@/lib/api/calendar"
import type { FileItem } from "@/lib/api/files"
import { allDayRange, formatDayTitle, parseServerDate } from "@/lib/dates"
import { eventTypeLabel } from "@/lib/eventColors"
import { eventRoom, joinLink, openMeetingWindow } from "@/lib/meetingWindow"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ItemMark } from "./EventBlock"
import { guestName, RESPONSE_WORD, ResponseMark } from "./GuestPicker"
import { callWindow, itemTimeText, itemTitle, JOIN_LEAD_MINUTES, joinOpen, recurrenceText, reminderText, type CalendarItem } from "./items"
import { useNow } from "./useNow"

type Reply = Exclude<EventResponse, "pending">

const REPLIES: { value: Reply; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "maybe", label: "Maybe" },
]

const ICON_BUTTON =
  "flex size-[2rem] items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring max-lg:size-11"
const ROW = "flex items-start gap-3 text-ui text-foreground"
const ROW_ICON = "mt-0.5 size-[1rem] shrink-0 text-muted-foreground"

function joinHint(event: CalendarEvent, now: Date): string {
  const end = callWindow(event)?.end
  return end && now >= end ? "This call has ended" : `Join opens ${JOIN_LEAD_MINUTES} minutes before`
}

/** The organizer heads the guest list and counts as going, like Google */
function peopleOf(event: CalendarEvent): { guest: EventAttendee; organizer: boolean }[] {
  const { organizer } = event
  const head = {
    guest: {
      user_id: organizer.id,
      first_name: organizer.first_name,
      last_name: organizer.last_name,
      avatar_url: organizer.avatar_url,
      response: "yes" as const,
    },
    organizer: true,
  }
  return [head, ...event.attendees.filter((guest) => guest.user_id !== organizer.id).map((guest) => ({ guest, organizer: false }))]
}

function responseCounts(guests: EventAttendee[]): string {
  const counts = new Map<EventResponse, number>()
  for (const guest of guests) counts.set(guest.response, (counts.get(guest.response) ?? 0) + 1)
  return (["yes", "no", "maybe", "pending"] as const)
    .filter((response) => counts.get(response))
    .map((response) => `${counts.get(response)} ${response === "pending" ? "awaiting" : RESPONSE_WORD[response].toLowerCase()}`)
    .join(", ")
}

function Description({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const node = ref.current
    if (node && !expanded) setClipped(node.scrollHeight > node.clientHeight + 1)
  }, [text, expanded])
  return (
    <div className="min-w-0 flex-1">
      <p ref={ref} className={cn("leading-[1.45] break-words whitespace-pre-wrap", !expanded && "line-clamp-4")}>
        {text}
      </p>
      {(clipped || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="mt-1 rounded-sm text-caption font-medium text-muted-foreground underline-offset-[0.2rem] hover:text-foreground hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  )
}

/** Papers and boards made or shown in this occurrence's call, that the user can open */
function useEventPapers(event: CalendarEvent | null, startsAt: string | null): FileItem[] {
  const [docs, setDocs] = useState<FileItem[]>([])
  const eventId = event?.video_call && !event.id.startsWith("temp-") ? (event.series_id ?? event.id) : null
  // A timed occurrence goes by its start, which the server reads in the event's zone. An all-day one by its own day,
  // both from this occurrence rather than the first of its series
  const day = event?.all_day && startsAt ? startsAt.slice(0, 10) : null
  const at = day ? null : (parseServerDate(startsAt)?.getTime() ?? null)
  useEffect(() => {
    setDocs([])
    const when = day ? { date: day } : at !== null ? { start: new Date(at) } : null
    if (!eventId || !when) return
    let live = true
    papersAPI.forEvent(eventId, when).then(
      (found) => live && setDocs(found),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [eventId, at, day])
  return docs
}

/**
 * Google's event card: the title, when it happens and how it repeats, the call with Join, the place,
 * the guests and their replies, the description and the reminder. Busy time shows only "Busy" and the time.
 */
export function EventDetailsPopover({
  open,
  userId,
  canEdit,
  canDelete,
  rule,
  onClose,
  onEdit,
  onDelete,
  onDuplicate,
  onRespond,
  returnFocus,
  side = "right",
}: {
  open: { item: CalendarItem; anchor: HTMLElement } | null
  userId: string | undefined
  canEdit: boolean
  /** Admins may delete events they cannot edit */
  canDelete: boolean
  /** The series' rule, for an occurrence that does not carry it */
  rule: string | null
  onClose: () => void
  onEdit: (event: CalendarEvent, anchor: HTMLElement) => void
  onDelete: (event: CalendarEvent) => void
  onDuplicate: (event: CalendarEvent) => void
  onRespond: (event: CalendarEvent, response: Reply) => void
  returnFocus?: () => void
  side?: PopoverSide
}) {
  const now = useNow()
  const item = open?.item
  return (
    <AnchoredPopover
      open={!!open}
      onOpenChange={(next) => !next && onClose()}
      anchor={open?.anchor ?? null}
      side={side}
      returnFocus={returnFocus}
      title={item ? itemTitle(item) : ""}
      className="w-[min(26rem,calc(100vw-1rem))] px-4 pt-2 pb-4"
    >
      {open && item && (
        <Details
          item={item}
          anchor={open.anchor}
          now={now}
          userId={userId}
          canEdit={canEdit}
          canDelete={canDelete}
          rule={rule}
          onClose={onClose}
          onEdit={onEdit}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
          onRespond={onRespond}
        />
      )}
    </AnchoredPopover>
  )
}

function Details({
  item,
  anchor,
  now,
  userId,
  canEdit,
  canDelete,
  rule,
  onClose,
  onEdit,
  onDelete,
  onDuplicate,
  onRespond,
}: {
  item: CalendarItem
  anchor: HTMLElement
  now: Date
  userId: string | undefined
  canEdit: boolean
  canDelete: boolean
  rule: string | null
  onClose: () => void
  onEdit: (event: CalendarEvent, anchor: HTMLElement) => void
  onDelete: (event: CalendarEvent) => void
  onDuplicate: (event: CalendarEvent) => void
  onRespond: (event: CalendarEvent, response: Reply) => void
}) {
  const { entry, person } = item
  const range = allDayRange(item)
  const day = range && range.first.getTime() === range.last.getTime() ? formatDayTitle(range.first) : ""
  const when = [day, itemTimeText(item)].filter(Boolean).join(", ")
  const event = entry.busy ? null : entry
  const saved = !!event && !event.id.startsWith("temp-")
  const guest = !!event && !person && !!userId && event.created_by !== userId && event.viewer_response !== null
  // The room lets in the organizer, guests and, for Everyone events, the whole workspace
  const joinable = !!event && (!person || event.created_by === userId || event.viewer_response !== null || event.everyone)
  const people = event ? peopleOf(event) : []
  const start = parseServerDate(item.starts_at)
  const joinHintId = useId()
  const repeats = event?.series_id ? recurrenceText(event.recurrence_rule ?? rule, start ?? new Date()) || "Repeats" : ""
  const papers = useEventPapers(event, item.starts_at)

  const copyLink = async () => {
    if (!event) return
    try {
      await navigator.clipboard.writeText(joinLink(eventRoom(event)))
      toast.success("Join link copied")
    } catch {
      toast.error("Couldn't copy the link")
    }
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="-mr-2 flex items-center justify-end gap-0.5">
        {event && saved && canEdit && (
          <button type="button" aria-label="Edit event" title="Edit" onClick={() => onEdit(event, anchor)} className={ICON_BUTTON}>
            <Pencil aria-hidden="true" className="size-[1rem]" />
          </button>
        )}
        {event && saved && (canEdit || canDelete) && (
          <button type="button" aria-label="Delete event" title="Delete" onClick={() => onDelete(event)} className={ICON_BUTTON}>
            <Trash aria-hidden="true" className="size-[1rem]" />
          </button>
        )}
        {event && saved && (
          <button type="button" aria-label="Duplicate event" title="Duplicate" onClick={() => onDuplicate(event)} className={ICON_BUTTON}>
            <Copy aria-hidden="true" className="size-[1rem]" />
          </button>
        )}
        <button type="button" aria-label="Close" title="Close" onClick={onClose} className={ICON_BUTTON}>
          <X aria-hidden="true" weight="bold" className="size-[0.9rem]" />
        </button>
      </div>

      <div className="flex items-start gap-3">
        <ItemMark item={item} className="mt-1.5 size-[1rem] rounded-sm" />
        <div className="min-w-0 flex-1">
          <p className="text-title leading-[1.3] font-semibold break-words text-foreground">{itemTitle(item)}</p>
          <p className="mt-1 text-ui text-foreground tabular-nums">{when}</p>
          {repeats && (
            <p className="mt-0.5 flex items-center gap-1.5 text-ui text-muted-foreground">
              <Repeat aria-hidden="true" className="size-[0.85rem]" />
              {repeats}
            </p>
          )}
        </div>
      </div>

      {event && person && (
        <p className={ROW}>
          <Calendar aria-hidden="true" className={ROW_ICON} />
          <span className="min-w-0 break-words">{person.name}</span>
        </p>
      )}

      {event && (
        <>
          {event.video_call && !joinable && (
            <p className={ROW}>
              <Video aria-hidden="true" className={ROW_ICON} />
              <span>Video call</span>
            </p>
          )}

          {event.video_call && joinable && (
            <div className="flex flex-wrap items-center gap-3.5 gap-y-2">
              <Video aria-hidden="true" className="size-[1rem] shrink-0 text-muted-foreground" />
              <Button
                variant={joinOpen(event, now) ? "join" : "secondary"}
                disabled={!joinOpen(event, now)}
                aria-describedby={joinOpen(event, now) ? undefined : joinHintId}
                onClick={() => void openMeetingWindow(eventRoom(event))}
                className="disabled:text-muted-foreground disabled:opacity-100"
              >
                Join video call
              </Button>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-ui font-medium text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11"
              >
                <Link aria-hidden="true" className="size-[0.95rem]" />
                Copy join link
              </button>
              {!joinOpen(event, now) && (
                <p id={joinHintId} className="basis-full pl-7 text-caption text-muted-foreground">
                  {joinHint(event, now)}
                </p>
              )}
            </div>
          )}

          {event.location && (
            <p className={ROW}>
              <MapPin aria-hidden="true" className={ROW_ICON} />
              <span className="min-w-0 break-words">{event.location}</span>
            </p>
          )}

          <div className={ROW}>
            <Users aria-hidden="true" className={ROW_ICON} />
            <div className="min-w-0 flex-1">
              {people.length > 1 && (
                <>
                  <p className="font-semibold">{people.length} guests</p>
                  <p className="text-caption text-muted-foreground">{responseCounts(people.map((person) => person.guest))}</p>
                </>
              )}
              <ul aria-label="Guests" className={cn("flex flex-col gap-1.5", people.length > 1 && "mt-2")}>
                {people.map(({ guest, organizer }) => (
                  <li key={guest.user_id} className="flex items-center gap-2">
                    <span className="relative shrink-0">
                      <UserAvatar
                        user={{ id: guest.user_id, first_name: guest.first_name, last_name: guest.last_name, avatar_url: guest.avatar_url }}
                        size="sm"
                        profile
                      />
                      {!organizer && <ResponseMark response={guest.response} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">
                          {guest.first_name || guest.last_name || guest.user_id !== userId ? (
                            <>
                              {guestName(guest)}
                              {guest.user_id === userId && <span className="text-muted-foreground"> (you)</span>}
                            </>
                          ) : (
                            "You"
                          )}
                        </span>
                        {/* The organizer made it, through their agent or AI */}
                        {organizer && markedVia(event.done_via) && <ViaMark via={event.done_via} personName={guestName(guest)} />}
                      </span>
                      {organizer && <span className="block text-caption text-muted-foreground">Organizer</span>}
                    </span>
                    {!organizer && <span className="shrink-0 text-caption text-muted-foreground">{RESPONSE_WORD[guest.response]}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {papers.length > 0 && (
            <div className={ROW}>
              <Paper aria-hidden="true" className={ROW_ICON} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">Papers</p>
                <ul aria-label="Papers" className="-mx-1.5 mt-1 flex flex-col gap-0.5">
                  {papers.map((doc) => (
                    <li key={doc.id}>
                      <RouterLink
                        to={`/${doc.docType ?? "paper"}/${doc.id}`}
                        onClick={onClose}
                        className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11"
                      >
                        <FileGlyph file={doc} className="size-[1.5rem]" />
                        <span className="min-w-0 flex-1 truncate">{doc.name}</span>
                      </RouterLink>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {event.description && (
            <div className={ROW}>
              <TextLeft aria-hidden="true" className={ROW_ICON} />
              <Description text={event.description} />
            </div>
          )}

          {event.reminder_minutes !== null && (
            <p className={ROW}>
              <Bell aria-hidden="true" className={ROW_ICON} />
              <span>{reminderText(event.reminder_minutes)}</span>
            </p>
          )}

          <p className="pl-7 text-caption text-muted-foreground">
            {[eventTypeLabel(event.event_type), event.everyone ? "Everyone" : null].filter(Boolean).join(", ")}
          </p>

          {guest && saved && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t-[0.0625rem] border-border pt-3">
              <span className="text-ui font-medium text-foreground">Going?</span>
              <SegmentedControl<EventResponse>
                label="Your reply"
                value={event.viewer_response ?? "pending"}
                options={REPLIES}
                onChange={(reply) => reply !== "pending" && onRespond(event, reply)}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
