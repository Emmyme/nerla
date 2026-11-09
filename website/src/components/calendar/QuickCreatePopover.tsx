import { useId, useRef, useState } from "react"
import { Clock, Video, X } from "@/components/icons"
import { AnchoredPopover, type PopoverSide, type VirtualAnchor } from "@/components/ui/anchored-popover"
import { Button } from "@/components/ui/button"
import { Collapse } from "@/components/ui/collapse"
import { TimeField } from "@/components/ui/time-field"
import { addDays, dayKey, parseDueDate, sameDay } from "@/lib/dates"
import type { EventType } from "@/lib/eventColors"
import { cn } from "@/lib/utils"
import { atTime, draftDays, draftSummary, timeValue, withAllDay, type EventDraft } from "./draft"
import { FIELD, TIME_FIELD, Toggle, TypePills } from "./EventFields"
import { followStart } from "./recurrence"

function TimeFields({ draft, onChange }: { draft: EventDraft; onChange: (draft: EventDraft) => void }) {
  const id = useId()
  const moved = (start: Date, end: Date): EventDraft => ({ ...draft, start, end, rule: followStart(draft.rule, draft.start, start) })
  const setDay = (value: string, which: "start" | "end") => {
    const day = parseDueDate(value)
    if (!day) return
    if (draft.allDay) {
      if (which === "start") {
        onChange(moved(day, addDays(day, Math.max(0, draftDays(draft)))))
      } else onChange({ ...draft, end: day < draft.start ? draft.start : day })
      return
    }
    const start = atTime(day, timeValue(draft.start))
    if (start) onChange(moved(start, new Date(start.getTime() + (draft.end.getTime() - draft.start.getTime()))))
  }
  const setStart = (value: string) => {
    const start = atTime(draft.start, value)
    if (start) onChange({ ...draft, start, end: new Date(start.getTime() + (draft.end.getTime() - draft.start.getTime())) })
  }
  // A timed draft dragged over several days gets its own end date, as in Google
  const multiDay = !draft.allDay && !sameDay(draft.start, new Date(draft.end.getTime() - 1))
  const setEnd = (value: string) => {
    let end = atTime(multiDay ? draft.end : draft.start, value)
    if (!end) return
    if (end <= draft.start) end = multiDay ? null : atTime(addDays(draft.start, 1), value)
    if (end) onChange({ ...draft, end })
  }
  const setEndDay = (value: string) => {
    const day = parseDueDate(value)
    const end = day && atTime(day, timeValue(draft.end))
    if (end && end > draft.start) onChange({ ...draft, end })
  }
  // One grid keeps every input mounted in the same order, so typing an end past midnight never moves the focused field
  return (
    <div className="flex flex-col gap-2 pb-1 pl-7">
      {draft.allDay ? (
        <div key="all-day" className="flex items-center gap-1.5">
          <input
            type="date"
            aria-label="Start date"
            value={dayKey(draft.start)}
            onChange={(e) => setDay(e.target.value, "start")}
            className={cn(FIELD, "flex-1")}
          />
          <span className="text-ui text-muted-foreground">to</span>
          <input
            type="date"
            aria-label="End date"
            value={dayKey(draft.end)}
            min={dayKey(draft.start)}
            onChange={(e) => setDay(e.target.value, "end")}
            className={cn(FIELD, "flex-1")}
          />
        </div>
      ) : (
        <div key="timed" className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-1.5 gap-y-2">
          <input
            type="date"
            aria-label={multiDay ? "Start date" : "Date"}
            value={dayKey(draft.start)}
            onChange={(e) => setDay(e.target.value, "start")}
            className={cn(FIELD, "w-full", multiDay ? "col-start-1 row-start-1" : "col-span-3 row-start-1")}
          />
          <TimeField
            aria-label="Start time"
            value={timeValue(draft.start)}
            onChange={setStart}
            className={cn(TIME_FIELD, "w-full", multiDay ? "col-start-3 row-start-1" : "col-start-1 row-start-2")}
          />
          {!multiDay && <span className="col-start-2 row-start-2 text-ui text-muted-foreground">to</span>}
          {multiDay && (
            <input
              type="date"
              aria-label="End date"
              value={dayKey(draft.end)}
              min={dayKey(draft.start)}
              onChange={(e) => setEndDay(e.target.value)}
              className={cn(FIELD, "col-start-1 row-start-2 w-full")}
            />
          )}
          <TimeField
            aria-label="End time"
            value={timeValue(draft.end)}
            durationFrom={multiDay ? undefined : timeValue(draft.start)}
            onChange={setEnd}
            className={cn(TIME_FIELD, "col-start-3 row-start-2 w-full")}
          />
        </div>
      )}
      <label htmlFor={`${id}-all-day`} className="flex w-fit cursor-pointer items-center gap-2 text-ui text-foreground">
        <input
          id={`${id}-all-day`}
          type="checkbox"
          checked={draft.allDay}
          onChange={(e) => onChange(withAllDay(draft, e.target.checked))}
          className="size-[1rem] accent-[var(--color-accent)]"
        />
        All day
      </label>
    </div>
  )
}

/**
 * Google's quick create: a title, the type, the time (which opens the time fields), and Video call.
 * The ghost on the grid follows every change, and More options carries the draft to the full editor.
 * Key it per draft, so each one starts folded.
 */
export function QuickCreatePopover({
  draft,
  anchor,
  onChange,
  onClose,
  onSave,
  onMoreOptions,
  returnFocus,
  side = "right",
}: {
  draft: EventDraft | null
  anchor: VirtualAnchor | null
  onChange: (draft: EventDraft) => void
  onClose: () => void
  onSave: (draft: EventDraft) => void
  onMoreOptions: (draft: EventDraft) => void
  returnFocus?: () => void
  /** Beside the ghost on wide screens, above or below it on a phone */
  side?: PopoverSide
}) {
  const titleRef = useRef<HTMLInputElement>(null)
  const [timesOpen, setTimesOpen] = useState(false)
  const [videoSet, setVideoSet] = useState(false)

  const setType = (type: EventType) => {
    if (!draft) return
    onChange({ ...draft, type, video: videoSet ? draft.video : type === "meeting" })
  }

  return (
    <AnchoredPopover
      open={!!draft}
      onOpenChange={(open) => !open && onClose()}
      anchor={anchor}
      side={side}
      returnFocus={returnFocus}
      title="New event"
      className="w-[min(24rem,calc(100vw-1rem))] p-4"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        titleRef.current?.focus()
      }}
    >
      {draft && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            onSave(draft)
          }}
        >
          <div className="flex items-start gap-2">
            <input
              ref={titleRef}
              aria-label="Title"
              placeholder="Add title"
              value={draft.title}
              onChange={(e) => onChange({ ...draft, title: e.target.value })}
              className="min-w-0 flex-1 border-b-[0.0625rem] border-border bg-transparent pt-0.5 pb-1.5 text-title font-semibold text-foreground transition-colors duration-150 placeholder:font-medium placeholder:text-muted-foreground focus:border-ring focus:outline-none"
            />
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="-mt-1 -mr-1.5 flex size-[1.75rem] shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:size-11"
            >
              <X aria-hidden="true" weight="bold" className="size-[0.85rem]" />
            </button>
          </div>

          <TypePills value={draft.type} onChange={setType} />

          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              aria-expanded={timesOpen}
              aria-label={`${draftSummary(draft)}, change the time`}
              onClick={() => setTimesOpen((open) => !open)}
              className="-mx-1.5 flex items-start gap-3 rounded-md px-1.5 py-1 text-left text-ui text-foreground transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
            >
              <Clock aria-hidden="true" className="mt-0.5 size-[1rem] shrink-0 text-muted-foreground" />
              <span className="tabular-nums">{draftSummary(draft)}</span>
            </button>
            <Collapse open={timesOpen} unmountClosed>
              <TimeFields draft={draft} onChange={onChange} />
            </Collapse>
          </div>

          <div className="flex items-center gap-3 text-ui text-foreground">
            <Video aria-hidden="true" className="size-[1rem] shrink-0 text-muted-foreground" />
            <span className="flex-1">Video call</span>
            <Toggle
              label="Video call"
              checked={draft.video}
              onChange={(video) => {
                setVideoSet(true)
                onChange({ ...draft, video })
              }}
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => onMoreOptions(draft)}>
              More options
            </Button>
            <Button type="submit" size="sm">
              Save
            </Button>
          </div>
        </form>
      )}
    </AnchoredPopover>
  )
}
