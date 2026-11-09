import { memo, useId, useMemo, useState, type ReactNode } from "react"
import { Link } from "react-router"
import { Check, ChevronDown, Settings, X } from "@/components/icons"
import { PeopleSearch, type PersonResult } from "@/components/projects/PeopleSearch"
import { Button } from "@/components/ui/button"
import { Collapse } from "@/components/ui/collapse"
import { MiniMonth } from "@/components/ui/mini-month"
import { useCalendarRange } from "@/lib/calendarStore"
import { addDays, allDayRange, dayKey, startOfMonth, startOfWeek } from "@/lib/dates"
import { EVENT_MARK, EVENT_TYPE_OPTIONS, eventTone, type EventTone, type EventType } from "@/lib/eventColors"
import { PERSON_STYLE } from "@/lib/personColors"
import { useTypeShapes } from "@/lib/typeShapes"
import { cn } from "@/lib/utils"
import type { TeamPerson } from "./items"
import { TypeGlyph } from "./TypeGlyph"

export const MAX_TEAM = 20

export type TeamSelection = TeamPerson & { shown: boolean }

const INK: Record<EventTone, string> = {
  sky: "text-app-sky-ink",
  lavender: "text-app-lavender-ink",
  pistachio: "text-app-pistachio-ink",
  bubblegum: "text-app-bubblegum-ink",
  lemon: "text-app-lemon-ink",
  away: "text-app-bg",
}

const ROW =
  "flex min-h-[2rem] items-center gap-2.5 rounded-md px-2 text-ui transition-colors duration-150 hover:bg-app-hover max-lg:min-h-11"

// Days of the shown mini month that hold any of the user's visible events
function useEventDots(month: Date, hidden: ReadonlySet<EventType>): Set<string> {
  const fromMs = startOfWeek(startOfMonth(month)).getTime()
  const toMs = addDays(new Date(fromMs), 42).getTime()
  const { events } = useCalendarRange(new Date(fromMs), new Date(toMs))
  return useMemo(() => {
    const dots = new Set<string>()
    const from = new Date(fromMs)
    for (const event of events) {
      if (hidden.has(event.event_type)) continue
      const range = allDayRange(event)
      if (!range) continue
      for (let day = range.first < from ? from : range.first; day <= range.last && day.getTime() < toMs; day = addDays(day, 1))
        dots.add(dayKey(day))
    }
    return dots
  }, [events, hidden, fromMs, toMs])
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  const id = useId()
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-0.5">
      <h2 id={`${id}-title`}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen((shown) => !shown)}
          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-body font-semibold text-foreground transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11"
        >
          {title}
          <ChevronDown
            aria-hidden="true"
            weight="bold"
            className={cn("motion-rotate size-[0.75rem] text-muted-foreground", open && "rotate-180")}
          />
        </button>
      </h2>
      <Collapse id={`${id}-body`} open={open} className="flex flex-col gap-0.5">
        {children}
      </Collapse>
    </section>
  )
}

// A native checkbox drawn as a square in the calendar's color: filled when on, ringed when off, grey when it cannot be used.
// The pastel ring alone is too faint on white, so off also keeps a field's edge in light
function ColorCheck({
  checked,
  onChange,
  fill,
  ring,
  ink,
  disabled = false,
  children,
}: {
  checked: boolean
  onChange: () => void
  fill: string
  ring: string
  ink: string
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <label className={cn(ROW, disabled ? "cursor-not-allowed hover:bg-transparent" : "cursor-pointer")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={cn(
          "flex size-[1rem] shrink-0 items-center justify-center rounded-sm transition-colors duration-150 peer-focus-visible:outline-[0.125rem] peer-focus-visible:outline-offset-[0.125rem] peer-focus-visible:outline-ring",
          checked
            ? fill
            : cn("ring-[0.125rem] ring-inset", disabled ? "ring-border" : cn(ring, "outline-[0.0625rem] outline-input dark:outline-0")),
        )}
      >
        {checked && <Check weight="bold" className={cn("size-[0.7rem]", ink)} />}
      </span>
      {children}
    </label>
  )
}

/**
 * The left column: Create, the mini month synced with the main view, the user's event types as
 * filters, and the teammates shown in Team view.
 */
export const CalendarSide = memo(function CalendarSide({
  date,
  today,
  month,
  onMonthChange,
  onSelectDay,
  rangeStart,
  rangeEnd,
  hidden,
  onToggleType,
  team,
  unshared,
  excludeIds,
  onAddPerson,
  onTogglePerson,
  onRemovePerson,
  onCreate,
  onNewMeeting,
}: {
  date: Date
  today: Date
  month: Date
  onMonthChange: (month: Date) => void
  onSelectDay: (day: Date) => void
  rangeStart: Date | null
  rangeEnd: Date | null
  hidden: ReadonlySet<EventType>
  onToggleType: (type: EventType) => void
  team: TeamSelection[]
  unshared: string[]
  excludeIds: string[]
  onAddPerson: (person: PersonResult) => void
  onTogglePerson: (id: string) => void
  onRemovePerson: (id: string) => void
  onCreate?: () => void
  onNewMeeting?: () => void
}) {
  const dots = useEventDots(month, hidden)
  const shapes = useTypeShapes()

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" shortcut="C" onClick={onCreate}>
          Create
        </Button>
        {onNewMeeting && (
          <Button type="button" variant="sky" shortcut="N" onClick={onNewMeeting}>
            New meeting
          </Button>
        )}
      </div>

      <MiniMonth
        value={date}
        today={today}
        month={month}
        onMonthChange={onMonthChange}
        onSelect={onSelectDay}
        dots={dots}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
      />

      <Section title="My calendar">
        {EVENT_TYPE_OPTIONS.map(({ type, label }) => {
          const tone = eventTone(type)
          return (
            <ColorCheck
              key={type}
              checked={!hidden.has(type)}
              onChange={() => onToggleType(type)}
              fill={EVENT_MARK[tone].bg}
              ring={EVENT_MARK[tone].ring}
              ink={INK[tone]}
            >
              {shapes && <TypeGlyph type={type} className="-mr-1 size-[0.85rem] text-muted-foreground" />}
              <span className="truncate text-foreground">{label}</span>
            </ColorCheck>
          )
        })}
      </Section>

      <Section title="Team">
        {team.length < MAX_TEAM ? (
          <div className="px-2 pb-1.5 [&_label]:sr-only">
            <PeopleSearch excludeIds={[...excludeIds, ...team.map((person) => person.id)]} onPick={onAddPerson} />
          </div>
        ) : (
          <p className="px-2 pb-1.5 text-caption text-muted-foreground">Up to {MAX_TEAM} people at a time</p>
        )}
        {team.length === 0 ? (
          <p className="px-2 text-caption text-muted-foreground">Add teammates to see their calendars next to yours.</p>
        ) : (
          <ul aria-label="Teammates" className="flex flex-col gap-0.5">
            {team.map((person) => {
              const style = PERSON_STYLE[person.tone]
              // A teammate who keeps their calendar private stays listed, greyed and unchecked
              const hiddenFromMe = unshared.includes(person.id)
              return (
                <li key={person.id} className="group relative flex items-center">
                  <div className="min-w-0 flex-1">
                    <ColorCheck
                      checked={person.shown && !hiddenFromMe}
                      disabled={hiddenFromMe}
                      onChange={() => onTogglePerson(person.id)}
                      fill={style.dot}
                      ring={style.ring}
                      ink={style.ink}
                    >
                      <span className="flex min-w-0 flex-col pr-7">
                        <span className={cn("truncate", hiddenFromMe ? "text-muted-foreground" : "text-foreground")}>{person.name}</span>
                        {hiddenFromMe && <span className="truncate text-micro text-muted-foreground">Not shared</span>}
                      </span>
                    </ColorCheck>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${person.name}`}
                    onClick={() => onRemovePerson(person.id)}
                    className="absolute right-[0.25rem] flex size-[1.5rem] items-center justify-center rounded-full text-muted-foreground transition-[opacity,color,background-color] duration-150 hover:bg-app-sunk hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:size-11 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100"
                  >
                    <X aria-hidden="true" weight="bold" className="size-[0.75rem]" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <Link
        to="/settings/calendar"
        className="flex items-center gap-2 self-start rounded-md px-2 py-1.5 text-ui font-medium text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11"
      >
        <Settings aria-hidden="true" className="size-[1rem]" />
        Sharing settings
      </Link>
    </div>
  )
})
