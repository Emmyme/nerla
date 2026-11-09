import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { useCoverDock } from "@/lib/dockCover"
import { Bell, Building, Clock, MapPin, Repeat, TextLeft, Users, Video } from "@/components/icons"
import { AutosizeTextarea } from "@/components/ui/autosize-textarea"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TimeField } from "@/components/ui/time-field"
import type { ReminderMinutes } from "@/lib/api/calendar"
import { addDays, sameDay } from "@/lib/dates"
import type { EventType } from "@/lib/eventColors"
import { cn } from "@/lib/utils"
import { DateField } from "./DateField"
import { atTime, draftDays, draftErrors, timeValue, withAllDay, type DraftErrors, type EventDraft } from "./draft"
import { FIELD, TIME_FIELD, Toggle, TypePills } from "./EventFields"
import { GuestPicker } from "./GuestPicker"
import { reminderText } from "./items"
import { RecurrencePicker } from "./RecurrencePicker"
import { followStart } from "./recurrence"

const NO_REMINDER = "none"
const REMINDERS: ReminderMinutes[] = [5, 10, 30, 60, 1440]
const ICON = "mt-2 size-[1rem] shrink-0 text-muted-foreground max-lg:mt-3"
const DAY_MS = 86_400_000

function Row({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-3.5", className)}>
      {icon}
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
    </div>
  )
}

function ToggleRow({
  icon,
  label,
  checked,
  onChange,
}: {
  icon: ReactNode
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const id = useId()
  return (
    <div className="flex items-center gap-3.5 text-ui text-foreground">
      {icon}
      <label htmlFor={id} className="flex-1 cursor-pointer py-1.5">
        {label}
      </label>
      <Toggle id={id} checked={checked} onChange={onChange} />
    </div>
  )
}

/** Start and end, each a date and a time, with All day. An end at or before the start on its day runs past midnight. */
function TimeRows({ draft, errors, onChange }: { draft: EventDraft; errors: DraftErrors; onChange: (draft: EventDraft) => void }) {
  const id = useId()
  const length = draft.end.getTime() - draft.start.getTime()
  const moved = (start: Date, end: Date): EventDraft => ({ ...draft, start, end, rule: followStart(draft.rule, draft.start, start) })

  const setStartDay = (day: Date) => {
    if (draft.allDay) return onChange(moved(day, addDays(day, draftDays(draft))))
    const start = atTime(day, timeValue(draft.start))
    if (start) onChange(moved(start, new Date(start.getTime() + length)))
  }
  const setStartTime = (value: string) => {
    const start = atTime(draft.start, value)
    if (start) onChange({ ...draft, start, end: new Date(start.getTime() + length) })
  }
  const setEndDay = (day: Date) => {
    if (draft.allDay) return onChange({ ...draft, end: day })
    const end = atTime(day, timeValue(draft.end))
    if (end) onChange({ ...draft, end })
  }
  const setEndTime = (value: string) => {
    let end = atTime(draft.end, value)
    if (!end) return
    if (end <= draft.start && sameDay(end, draft.start)) end = atTime(addDays(draft.start, 1), value) ?? end
    onChange({ ...draft, end })
  }

  const invalid = !!errors.end
  return (
    <>
      <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 text-ui">
        <span className="text-muted-foreground">Start</span>
        <DateField label="Start date" value={draft.start} onChange={setStartDay} className="w-full" />
        {draft.allDay ? (
          <span />
        ) : (
          <TimeField aria-label="Start time" value={timeValue(draft.start)} onChange={setStartTime} className={TIME_FIELD} />
        )}
        <span className="text-muted-foreground">End</span>
        <DateField label="End date" value={draft.end} onChange={setEndDay} invalid={invalid} className="w-full" />
        {draft.allDay ? (
          <span />
        ) : (
          <TimeField
            aria-label="End time"
            value={timeValue(draft.end)}
            durationFrom={length > 0 && length < DAY_MS ? timeValue(draft.start) : undefined}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${id}-end` : undefined}
            onChange={setEndTime}
            className={TIME_FIELD}
          />
        )}
      </div>
      {errors.end && (
        <FieldError id={`${id}-end`} className="mt-0">
          {errors.end}
        </FieldError>
      )}
      <label htmlFor={`${id}-all-day`} className="flex w-fit cursor-pointer items-center gap-2 py-1 text-ui text-foreground">
        <input
          id={`${id}-all-day`}
          type="checkbox"
          checked={draft.allDay}
          onChange={(e) => onChange(withAllDay(draft, e.target.checked))}
          className="size-[1rem] accent-[var(--color-accent)]"
        />
        All day
      </label>
    </>
  )
}

/**
 * The full event editor, Google's "More options": every field of one event. It sits in a right panel
 * on desktop and fills the screen on a phone. Escape and Cancel leave without saving.
 */
export function EventEditor({
  draft,
  ownerId,
  onChange,
  onSave,
  onCancel,
}: {
  draft: EventDraft
  /** Who the event belongs to, never one of its guests */
  ownerId: string | undefined
  onChange: (draft: EventDraft) => void
  onSave: (draft: EventDraft) => void
  onCancel: () => void
}) {
  const rootRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  useCoverDock()
  const [tried, setTried] = useState(false)
  const [videoSet, setVideoSet] = useState(!!draft.event || draft.video)
  const id = useId()
  const errors = tried ? draftErrors(draft) : {}
  const editing = !!draft.event
  const heading = editing ? "Edit event" : "New event"

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const setType = (type: EventType) => {
    const next = { ...draft, type, video: videoSet ? draft.video : type === "meeting" }
    onChange(type === "ooo" && !draft.allDay ? withAllDay(next, true) : next)
  }

  const submit = () => {
    const found = draftErrors(draft)
    setTried(true)
    if (found.title) return titleRef.current?.focus()
    if (found.end) return rootRef.current?.querySelector<HTMLElement>('[aria-label="End time"], [aria-label^="End date"]')?.focus()
    onSave(draft)
  }

  // Calendar shortcuts stay out of the form. Escape from a menu or dialog inside it closes only that.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation()
      if (event.nativeEvent.isComposing || !(event.target instanceof Node) || !rootRef.current?.contains(event.target)) return
      event.preventDefault()
      onCancel()
      return
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation()
  }

  return (
    <section
      ref={rootRef}
      aria-label={heading}
      data-event-editor=""
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 flex-col bg-card text-foreground"
    >
      <header className="flex shrink-0 items-center gap-2 border-b-[0.0625rem] border-border px-5 py-2.5 max-lg:px-4">
        <h2 className="flex-1 text-body font-semibold text-foreground">{heading}</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" form={`${id}-form`}>
          Save
        </Button>
      </header>

      <form
        id={`${id}-form`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pt-4 pb-5 max-lg:px-4 max-lg:pb-[max(1.25rem,env(safe-area-inset-bottom))]"
      >
        <div>
          <input
            ref={titleRef}
            aria-label="Title"
            placeholder={draft.type === "ooo" ? "Out of office" : "Add title"}
            value={draft.title}
            aria-invalid={!!errors.title || undefined}
            aria-describedby={errors.title ? `${id}-title` : undefined}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
            className="w-full border-b-[0.0625rem] border-border bg-transparent pt-0.5 pb-1.5 text-title font-semibold text-foreground transition-colors duration-150 placeholder:font-medium placeholder:text-muted-foreground focus:border-ring focus:outline-none aria-invalid:border-app-berry"
          />
          {errors.title && <FieldError id={`${id}-title`}>{errors.title}</FieldError>}
        </div>

        <TypePills value={draft.type} onChange={setType} />

        <Row icon={<Clock aria-hidden="true" className={ICON} />}>
          <TimeRows draft={draft} errors={errors} onChange={onChange} />
        </Row>

        <Row icon={<Repeat aria-hidden="true" className={ICON} />}>
          <RecurrencePicker rule={draft.rule} start={draft.start} onChange={(rule) => onChange({ ...draft, rule, ruleTouched: true })} />
        </Row>

        <ToggleRow
          icon={<Video aria-hidden="true" className="size-[1rem] shrink-0 text-muted-foreground" />}
          label="Video call"
          checked={draft.video}
          onChange={(video) => {
            setVideoSet(true)
            onChange({ ...draft, video })
          }}
        />

        <Row icon={<Users aria-hidden="true" className={cn(ICON, "mt-0.5 max-lg:mt-0.5")} />}>
          <GuestPicker guests={draft.guests} ownerId={ownerId} onChange={(guests) => onChange({ ...draft, guests })} />
        </Row>

        <ToggleRow
          icon={<Building aria-hidden="true" className="size-[1rem] shrink-0 text-muted-foreground" />}
          label="Show to everyone in the workspace"
          checked={draft.everyone}
          onChange={(everyone) => onChange({ ...draft, everyone })}
        />

        <Row icon={<MapPin aria-hidden="true" className={ICON} />}>
          <input
            aria-label="Location"
            placeholder="Add location"
            maxLength={500}
            value={draft.location}
            onChange={(e) => onChange({ ...draft, location: e.target.value })}
            className={cn(FIELD, "w-full")}
          />
        </Row>

        <Row icon={<TextLeft aria-hidden="true" className={ICON} />}>
          <AutosizeTextarea
            aria-label="Description"
            placeholder="Add description"
            maxLength={10000}
            cap="max-h-[16rem]"
            containerClassName="w-full"
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
            className={cn(FIELD, "h-auto min-h-[5.5rem] w-full py-2 leading-[1.45] max-lg:h-auto")}
          />
        </Row>

        <Row icon={<Bell aria-hidden="true" className={ICON} />}>
          <Select
            value={draft.reminder === null ? NO_REMINDER : String(draft.reminder)}
            onValueChange={(value) => onChange({ ...draft, reminder: value === NO_REMINDER ? null : (Number(value) as ReminderMinutes) })}
          >
            <SelectTrigger aria-label="Reminder" className="px-2.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_REMINDER} className="text-ui">
                No reminder
              </SelectItem>
              {[...REMINDERS, ...(draft.reminder !== null && !REMINDERS.includes(draft.reminder) ? [draft.reminder] : [])].map(
                (minutes) => (
                  <SelectItem key={minutes} value={String(minutes)} className="text-ui">
                    {reminderText(minutes)}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </Row>
      </form>
    </section>
  )
}
