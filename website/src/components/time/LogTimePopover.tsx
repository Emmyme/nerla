import { useId, useState, type FormEvent, type ReactElement } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DateInput } from "@/components/ui/DateInput"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { POPOVER_SURFACE, useAnchoredPosition } from "@/components/ui/anchored-popover"
import { timeAPI, type TimeEntry, type TimeEntryPatch, type TimePlace } from "@/lib/api/time"
import { toDueDateValue } from "@/lib/dates"
import { messageOf } from "@/lib/taskStore"
import { formatMinutes, parseDuration, todayIn } from "@/lib/timeFormat"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"
import { choiceOf, PERSONAL, PlacePicker, placeOf, type PlaceChoice } from "./PlacePicker"

const QUICK = [15, 30, 60]
const DAY = 1440
const LABEL = "text-caption font-medium text-muted-foreground"
const LOG_FAILED = "Couldn't log the time. Try again."
const SAVE_FAILED = "Couldn't save the entry. Try again."
const DELETE_FAILED = "Couldn't delete the entry. Try again."

/**
 * Logs time on a task or a project: a quick length or an exact one, on a date, with a note. Without a fixed
 * place it asks for a project and a task, and with an entry it changes or deletes that one
 */
export function LogTimePopover({
  place,
  date,
  entry,
  onLogged,
  onDeleted,
  className,
  children,
}: {
  place?: TimePlace
  /** The day it opens on, today when not given */
  date?: string
  entry?: TimeEntry
  onLogged?: (entry: TimeEntry) => void
  onDeleted?: (entry: TimeEntry) => void
  className?: string
  /** The trigger in place of the Log time button */
  children?: ReactElement
}) {
  const [open, setOpen] = useState(false)
  const { anchorRef, contentRef, style } = useAnchoredPosition(open)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal={false}>
      {children ? (
        <Dialog.Trigger asChild ref={anchorRef}>
          {children}
        </Dialog.Trigger>
      ) : (
        <Dialog.Trigger asChild>
          <Button ref={anchorRef} type="button" variant="ghost" className={className}>
            Log time
          </Button>
        </Dialog.Trigger>
      )}
      <Dialog.Portal>
        <Dialog.Content
          ref={contentRef}
          aria-describedby={undefined}
          style={style}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            "fixed z-50 flex max-h-[calc(100dvh-1rem)] flex-col overflow-y-auto p-3",
            place ? "w-[18rem] max-lg:w-[20rem]" : "w-[20rem] max-w-[calc(100vw-1rem)]",
            POPOVER_SURFACE,
          )}
        >
          <Dialog.Title className="pb-2 text-ui font-semibold text-foreground">{entry ? "Edit time" : "Log time"}</Dialog.Title>
          <LogTimeForm
            place={place}
            date={date}
            entry={entry}
            onLogged={(saved) => {
              setOpen(false)
              onLogged?.(saved)
            }}
            onDeleted={(gone) => {
              setOpen(false)
              onDeleted?.(gone)
            }}
            onCancel={() => setOpen(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Only what changed, or null when nothing did */
function patchOf(
  entry: TimeEntry,
  next: { minutes: number; date: string; note: string | null; choice: PlaceChoice },
): TimeEntryPatch | null {
  const patch: TimeEntryPatch = {}
  if (next.minutes !== entry.minutes) patch.minutes = next.minutes
  if (next.date !== entry.date) patch.date = next.date
  if (next.note !== (entry.note ?? null)) patch.note = next.note
  const before = choiceOf(entry)
  if (next.choice.project !== before.project || next.choice.task !== before.task) {
    if (next.choice.project === PERSONAL) patch.taskId = next.choice.task
    else {
      patch.projectId = next.choice.project ?? undefined
      patch.taskId = next.choice.task
    }
  }
  return Object.keys(patch).length ? patch : null
}

function LogTimeForm({
  place,
  date: startDate,
  entry,
  onLogged,
  onDeleted,
  onCancel,
}: {
  place?: TimePlace
  date?: string
  entry?: TimeEntry
  onLogged: (entry: TimeEntry) => void
  onDeleted: (entry: TimeEntry) => void
  onCancel: () => void
}) {
  const { user } = useAuth()
  const ids = useId()
  const [length, setLength] = useState(() => (entry ? formatMinutes(entry.minutes) : ""))
  const [date, setDate] = useState(() => entry?.date ?? startDate ?? todayIn(user?.timeZone))
  const [note, setNote] = useState(entry?.note ?? "")
  const [choice, setChoice] = useState<PlaceChoice>(() => (entry ? choiceOf(entry) : { project: null, task: null }))
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<"ask" | "busy" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const minutes = parseDuration(length)
  const lengthError = minutes === null ? "Enter a length like 1h 30m." : minutes > DAY ? "Log at most 24h at a time." : null
  const dateValue = toDueDateValue(date)
  const dateError = dateValue ? null : "Enter a date."
  const target = place ?? placeOf(choice)
  const placeError = target ? null : choice.project === PERSONAL ? "Pick a task." : "Pick a project."

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTried(true)
    if (lengthError || !dateValue || minutes === null || !target || saving) return
    const noteValue = note.trim() || null
    setSaving(true)
    setError(null)
    try {
      if (entry) {
        const patch = patchOf(entry, { minutes, date: dateValue, note: noteValue, choice })
        onLogged(patch ? (await timeAPI.updateEntry(entry.id, patch)).entry : entry)
        return
      }
      const created = await timeAPI.createEntry({ ...target, date: dateValue, minutes, note: noteValue, source: "manual" })
      toast.success(`Logged ${formatMinutes(created.entry.minutes)}`)
      onLogged(created.entry)
    } catch (err) {
      setError(messageOf(err, entry ? SAVE_FAILED : LOG_FAILED))
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!entry || deleting === "busy") return
    setDeleting("busy")
    setError(null)
    try {
      await timeAPI.deleteEntry(entry.id)
      onDeleted(entry)
    } catch (err) {
      setError(messageOf(err, DELETE_FAILED))
      setDeleting("ask")
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <div role="group" aria-label="Quick lengths" className="flex gap-1.5">
        {QUICK.map((quick) => {
          const text = formatMinutes(quick)
          const picked = minutes === quick
          return (
            <button
              key={quick}
              type="button"
              aria-pressed={picked}
              onClick={() => setLength(text)}
              className={cn(
                "inline-flex h-8 flex-1 items-center justify-center rounded-md text-ui font-medium tabular-nums transition-colors duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:h-11",
                picked ? "bg-app-sky-soft text-app-sky-ink" : "bg-app-sunk text-foreground hover:bg-app-hover",
              )}
            >
              {text}
            </button>
          )
        })}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-length`} className={LABEL}>
          Length
        </label>
        <Input
          id={`${ids}-length`}
          autoFocus
          autoComplete="off"
          placeholder="1h 30m"
          value={length}
          onChange={(event) => setLength(event.target.value)}
          aria-invalid={tried && !!lengthError ? true : undefined}
          aria-describedby={tried && lengthError ? `${ids}-length-error` : undefined}
          className="tabular-nums"
        />
        {tried && lengthError && (
          <FieldError id={`${ids}-length-error`} className="mt-0">
            {lengthError}
          </FieldError>
        )}
      </div>
      {!place && <PlacePicker value={choice} onChange={setChoice} known={entry} idPrefix={ids} error={tried ? placeError : null} />}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-date`} className={LABEL}>
          Date
        </label>
        <DateInput
          id={`${ids}-date`}
          value={date}
          onChange={setDate}
          error={tried && dateError ? dateError : undefined}
          className="h-8 text-ui max-lg:h-11"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-note`} className={LABEL}>
          Note
        </label>
        <Input
          id={`${ids}-note`}
          autoComplete="off"
          maxLength={500}
          placeholder="Optional"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="text-caption text-app-berry-text">
          {error}
        </p>
      )}
      {entry && deleting ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-ui text-foreground">Delete this entry?</span>
          <Button type="button" variant="ghost" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" aria-busy={deleting === "busy" || undefined} onClick={() => void remove()}>
            {deleting === "busy" ? "Deleting" : "Delete"}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          {entry && (
            <Button type="button" variant="ghost" onClick={() => setDeleting("ask")} className="mr-auto text-app-berry-text">
              Delete
            </Button>
          )}
          {entry && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" aria-busy={saving || undefined}>
            {entry ? (saving ? "Saving" : "Save") : saving ? "Logging" : "Log time"}
          </Button>
        </div>
      )}
    </form>
  )
}
