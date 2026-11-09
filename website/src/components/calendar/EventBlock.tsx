import type { CSSProperties, KeyboardEvent } from "react"
import { Away, Sunglasses } from "@/components/icons"
import { formatTime } from "@/lib/dates"
import {
  EVENT_FILL,
  EVENT_MARK,
  EVENT_PAST,
  eventTone,
  inviteDeclinedSurface,
  invitePendingSurface,
  type EventType,
} from "@/lib/eventColors"
import { initialsOf, PERSON_STYLE } from "@/lib/personColors"
import { useTypeShapes } from "@/lib/typeShapes"
import { cn } from "@/lib/utils"
import { GLYPH_INK, TypeGlyph } from "./TypeGlyph"
import { hasEnded, inviteOf, isAway, itemLabel, itemTimes, itemTimeText, itemTitle, type CalendarItem } from "./items"
import type { NudgeKey } from "./timeMath"

export type OpenItem = (item: CalendarItem, anchor: HTMLElement) => void
/** Alt and an arrow on a focused event, with Shift to resize */
export type NudgeItem = (item: CalendarItem, key: NudgeKey, resize: boolean) => void

/** What makes an event movable: drag data for the grid, and the keyboard nudge */
type Movable = { draggable?: boolean; dragging?: boolean; onNudge?: NudgeItem }

const NUDGE_KEYS = new Set<string>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])
const NUDGE_SHORTCUTS =
  "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
// The spot an event is dragged away from, a dashed full ring
const LEFT_BEHIND =
  "bg-transparent text-muted-foreground ring-0 dark:bg-transparent dark:text-muted-foreground dark:ring-0 outline-dashed outline-[0.0625rem] -outline-offset-[0.0625rem] outline-muted-foreground"

function movableProps(item: CalendarItem, { draggable, dragging, onNudge }: Movable) {
  return {
    "data-event-key": item.key,
    "data-draggable": draggable ? "" : undefined,
    "aria-keyshortcuts": onNudge ? NUDGE_SHORTCUTS : undefined,
    onKeyDown: onNudge
      ? (e: KeyboardEvent<HTMLButtonElement>) => {
          if (!e.altKey || e.ctrlKey || e.metaKey || !NUDGE_KEYS.has(e.key)) return
          e.preventDefault()
          e.stopPropagation()
          onNudge(item, e.key as NudgeKey, e.shiftKey)
        }
      : undefined,
    ...(dragging ? { "data-dragging": "" } : {}),
  }
}

const FOCUS = "focus-visible:outline-[0.125rem] focus-visible:outline-offset-[0.0625rem] focus-visible:outline-ring"
// Keeps a quiet hairline around small marks, so the pale lemon still reads on white
export const MARK_RING = "shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--color-text)_14%,transparent)]"

const SUNK = "bg-app-sunk text-muted-foreground ring-[0.0625rem] ring-inset"

// Separates a block from the earlier block it is drawn over
const STACKED = "shadow-[0_0_0_0.0625rem_var(--color-card)]"

/**
 * The user's own event in the type's fill from EVENT_FILL, or EVENT_PAST once it has ended. An unanswered invite
 * is outlined and a declined one is quiet. A teammate's, busy time too, is the card with a full ring in their color,
 * a hairline once past, so it never reads as the user's own.
 */
function itemSurface(item: CalendarItem, past = false): string {
  const { entry, person } = item
  if (person)
    return cn(
      isAway(entry) ? "bg-app-sunk" : "bg-card",
      "text-foreground ring-inset",
      past ? "ring-[0.0625rem]" : "ring-[0.125rem]",
      PERSON_STYLE[person.tone].ring,
    )
  if (entry.busy) return cn(SUNK, "ring-border")
  const tone = eventTone(entry.event_type)
  const invite = inviteOf(item)
  if (invite === "pending") return invitePendingSurface(tone, past)
  if (invite === "declined") return inviteDeclinedSurface(tone)
  return past ? EVENT_PAST[tone] : EVENT_FILL[tone]
}

/** A declined event's title is struck through */
export const struck = (item: CalendarItem) => (inviteOf(item) === "declined" ? "line-through" : undefined)

/**
 * The time and place lines: a quiet ink, or the muted text once past. In dark the user's past events keep their
 * pastel lines at 80%.
 */
const quiet = (item: CalendarItem, past: boolean) => {
  if (item.person && past) return "text-muted-foreground"
  return past && !inviteOf(item) && !item.entry.busy ? "text-muted-foreground dark:text-current dark:opacity-80" : "opacity-80"
}

/** A teammate's initials in their color, before the title */
function PersonMark({ item, className }: { item: CalendarItem; className?: string }) {
  if (!item.person) return null
  const style = PERSON_STYLE[item.person.tone]
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mr-1 inline-flex size-[1rem] shrink-0 items-center justify-center rounded-full align-[-0.25rem] text-micro leading-none font-semibold",
        style.dot,
        style.ink,
        className,
      )}
    >
      {initialsOf(item.person.name)}
    </span>
  )
}

/** The small airplane before an out of office title */
function AwayMark({ item, className }: { item: CalendarItem; className?: string }) {
  if (!isAway(item.entry)) return null
  return <Away aria-hidden="true" weight="bold" className={cn("mr-1 inline size-[0.75rem] shrink-0 align-[-0.125rem]", className)} />
}

/** The type of the user's own event, the one thing its color says. Out of office has its own mark already */
function shownType({ entry, person }: CalendarItem): string | null {
  return person || entry.busy || isAway(entry) ? null : entry.event_type
}

/** Filled like the dot, outlined like the ring of an invite */
const glyphWeight = (item: CalendarItem) => {
  const invite = inviteOf(item)
  return invite === "pending" ? "bold" : invite === "declined" ? "regular" : "fill"
}

/** The type's shape before the title, in the block's ink, for users who turn on shapes with colors */
function TypeMark({ item, className }: { item: CalendarItem; className?: string }) {
  const shapes = useTypeShapes()
  const type = shownType(item)
  if (!shapes || !type) return null
  return <TypeGlyph type={type} weight={glyphWeight(item)} className={cn("mr-1 inline size-[0.75rem] align-[-0.125rem]", className)} />
}

/** A filled dot, or a ring in the tone on the card for an unanswered or declined invite */
function itemDot(item: CalendarItem): string {
  if (item.person) return PERSON_STYLE[item.person.tone].dot
  if (item.entry.busy) return "bg-muted-foreground"
  const mark = EVENT_MARK[eventTone(item.entry.event_type)]
  const invite = inviteOf(item)
  if (invite) return cn("bg-card ring-inset", invite === "pending" ? "ring-[0.125rem]" : "ring-[0.0625rem]", mark.ring)
  return mark.bg
}

/**
 * The mark before an item, a dot in its tone, or berry sunglasses for out of office.
 * The sunglasses take the dot's place and spill a little past it, so they stay readable.
 */
export function ItemMark({ item, className }: { item: CalendarItem; className: string }) {
  const shapes = useTypeShapes()
  const type = shownType(item)
  if (!item.person && isAway(item.entry)) return <OooMark className={className} />
  if (shapes && type) {
    return (
      <span aria-hidden="true" className={cn("relative flex shrink-0 items-center justify-center", className)}>
        <TypeGlyph
          type={type}
          weight={glyphWeight(item)}
          className={cn("absolute size-[160%] max-h-[1.25rem] max-w-[1.25rem]", GLYPH_INK[eventTone(type)])}
        />
      </span>
    )
  }
  return <span aria-hidden="true" className={cn("shrink-0", className, itemDot(item), MARK_RING)} />
}

export function OooMark({ className }: { className: string }) {
  return (
    <span aria-hidden="true" className={cn("relative flex shrink-0 items-center justify-center", className)}>
      <Sunglasses weight="fill" className="absolute size-[160%] max-h-[1.25rem] max-w-[1.25rem] text-app-berry" />
    </span>
  )
}

/** A timed event in the week and day grid. Short blocks put the start time on the title line. */
export function EventBlock({
  item,
  minutes,
  now,
  style,
  onOpen,
  resizable = false,
  stacked = false,
  ...movable
}: {
  item: CalendarItem
  minutes: number
  now: Date
  style: CSSProperties
  onOpen?: OpenItem
  /** Shows the bottom edge handle, on the piece that holds the real end */
  resizable?: boolean
  /** Drawn over an earlier block, so it gets a thin card-colored edge */
  stacked?: boolean
} & Movable) {
  const times = itemTimes(item)
  const location = !item.entry.busy ? item.entry.location : null
  const compact = minutes < 45
  const past = hasEnded(item, now)
  return (
    <button
      type="button"
      aria-label={itemLabel(item)}
      onClick={(e) => onOpen?.(item, e.currentTarget)}
      style={style}
      {...movableProps(item, movable)}
      className={cn(
        "absolute flex flex-col overflow-hidden rounded-md px-1.5 text-left text-caption leading-[1.25] transition-[filter] duration-150 [-webkit-touch-callout:none] hover:brightness-[0.97]",
        compact ? "justify-center py-0" : "py-1",
        itemSurface(item, past),
        stacked && STACKED,
        movable.dragging && LEFT_BEHIND,
        FOCUS,
      )}
    >
      {compact ? (
        <span className="truncate whitespace-nowrap">
          <PersonMark item={item} />
          <AwayMark item={item} />
          <TypeMark item={item} />
          <span className={cn("font-semibold", struck(item))}>{itemTitle(item)}</span>
          {times && <span className={cn("tabular-nums", quiet(item, past))}>, {formatTime(times.start)}</span>}
        </span>
      ) : (
        <>
          <span className={cn("font-semibold", minutes < 75 ? "truncate" : "line-clamp-2")}>
            <PersonMark item={item} />
            <AwayMark item={item} />
            <TypeMark item={item} />
            <span className={struck(item)}>{itemTitle(item)}</span>
          </span>
          <span className={cn("truncate tabular-nums", quiet(item, past))}>{itemTimeText(item)}</span>
          {location && minutes >= 75 && <span className={cn("truncate", quiet(item, past))}>{location}</span>}
        </>
      )}
      {movable.draggable && resizable && !movable.dragging && (
        <span data-resize="" aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[0.5rem] cursor-ns-resize" />
      )}
    </button>
  )
}

/** An all-day or multi-day bar, square on the sides where it runs on past the visible days */
export function EventBar({
  item,
  now,
  continuesBefore = false,
  continuesAfter = false,
  compact = false,
  style,
  className,
  onOpen,
  ...movable
}: {
  item: CalendarItem
  now: Date
  continuesBefore?: boolean
  continuesAfter?: boolean
  compact?: boolean
  style?: CSSProperties
  className?: string
  onOpen?: OpenItem
} & Movable) {
  const times = itemTimes(item)
  const showTime = !compact && !item.all_day && !continuesBefore && times
  const past = hasEnded(item, now)
  return (
    <button
      type="button"
      aria-label={itemLabel(item)}
      onClick={(e) => onOpen?.(item, e.currentTarget)}
      style={style}
      {...movableProps(item, movable)}
      className={cn(
        "flex h-[1.25rem] items-center gap-1 overflow-hidden rounded-md px-1.5 text-left text-caption leading-none font-semibold transition-[filter] duration-150 [-webkit-touch-callout:none] hover:brightness-[0.97]",
        compact && "px-1 text-micro",
        continuesBefore && "rounded-l-none",
        continuesAfter && "rounded-r-none",
        itemSurface(item, past),
        movable.dragging && LEFT_BEHIND,
        FOCUS,
        className,
      )}
    >
      <PersonMark item={item} className="mr-0" />
      <AwayMark item={item} className="mr-0" />
      <TypeMark item={item} className="mr-0" />
      {showTime && <span className={cn("shrink-0 tabular-nums", quiet(item, past))}>{formatTime(times.start)}</span>}
      <span className={cn("truncate", struck(item))}>{itemTitle(item)}</span>
    </button>
  )
}

/** A timed event in a month cell: a dot, the start time and the title */
export function EventChip({
  item,
  now,
  style,
  className,
  onOpen,
  ...movable
}: { item: CalendarItem; now: Date; style?: CSSProperties; className?: string; onOpen?: OpenItem } & Movable) {
  const times = itemTimes(item)
  return (
    <button
      type="button"
      aria-label={itemLabel(item)}
      onClick={(e) => onOpen?.(item, e.currentTarget)}
      style={style}
      {...movableProps(item, movable)}
      className={cn(
        "flex h-[1.25rem] items-center gap-1 overflow-hidden rounded-md px-1 text-left text-caption leading-none text-foreground transition-colors duration-150 [-webkit-touch-callout:none] hover:bg-app-hover",
        hasEnded(item, now) && "text-muted-foreground",
        movable.dragging && LEFT_BEHIND,
        FOCUS,
        className,
      )}
    >
      {/* A teammate's initials, as on their blocks, so whose it is never rests on the color */}
      {item.person ? <PersonMark item={item} className="mr-0" /> : <ItemMark item={item} className="size-[0.5rem] rounded-full" />}
      {times && <span className="shrink-0 text-muted-foreground tabular-nums">{formatTime(times.start)}</span>}
      <span className={cn("truncate font-semibold", struck(item))}>{itemTitle(item)}</span>
    </button>
  )
}

/**
 * A new event being made, or an event dragged to a new spot: a full pastel fill with a strong ring in the tone,
 * never a stripe. `data-calendar-ghost` marks the piece a popover anchors to.
 */
export function GhostBlock({
  type,
  item,
  title,
  time,
  start,
  minutes,
  bar = false,
  anchor = false,
  continuesBefore = false,
  continuesAfter = false,
  style,
  className,
}: {
  type?: EventType
  item?: CalendarItem
  title: string
  time?: string
  /** With `minutes` under 45, a short block puts the start time on the title line, as EventBlock does */
  start?: Date
  minutes?: number
  bar?: boolean
  anchor?: boolean
  continuesBefore?: boolean
  continuesAfter?: boolean
  style?: CSSProperties
  className?: string
}) {
  const tone = eventTone(item && !item.entry.busy ? item.entry.event_type : type)
  const surface = cn(EVENT_MARK[tone].ring, item ? itemSurface(item) : EVENT_FILL[tone], "ring-[0.125rem]")
  const compact = !bar && minutes !== undefined && minutes < 45
  const shapes = useTypeShapes()
  const glyphType = !shapes ? null : item ? (item.person || item.entry.busy ? null : item.entry.event_type) : (type ?? "event")
  const glyph = glyphType && <TypeGlyph type={glyphType} className={cn("inline size-[0.75rem] align-[-0.125rem]", !bar && "mr-1")} />
  return (
    <div
      aria-hidden="true"
      data-calendar-ghost={anchor ? "" : undefined}
      style={style}
      className={cn(
        "pointer-events-none absolute z-20 overflow-hidden text-caption ring-[0.125rem] ring-inset",
        bar
          ? "flex h-[1.25rem] items-center gap-1 rounded-md px-1.5 leading-none font-semibold"
          : cn("flex flex-col rounded-md px-1.5 leading-[1.25]", compact ? "justify-center py-0" : "py-1"),
        continuesBefore && "rounded-l-none",
        continuesAfter && "rounded-r-none",
        surface,
        className,
      )}
    >
      {compact ? (
        <span className="truncate whitespace-nowrap">
          {glyph}
          <span className="font-semibold">{title}</span>
          {start && <span className="tabular-nums opacity-80">, {formatTime(start)}</span>}
        </span>
      ) : (
        <>
          {bar && glyph}
          <span className="truncate font-semibold">
            {!bar && glyph}
            {title}
          </span>
          {!bar && time && <span className="truncate tabular-nums opacity-80">{time}</span>}
        </>
      )}
    </div>
  )
}
