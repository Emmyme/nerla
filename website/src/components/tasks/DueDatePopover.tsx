import { useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { Calendar } from "@/components/icons"
import { POPOVER_SURFACE, useAnchoredPosition } from "@/components/ui/anchored-popover"
import { DateInput } from "@/components/ui/DateInput"
import { MiniMonth } from "@/components/ui/mini-month"
import { addDays, formatDue, formatShortDate, formatWeekdayShort, parseDueDate, startOfDay, startOfWeek, toDueDateValue } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { PICKER_TRIGGER, PICKER_VARIANT, type PickerVariant } from "./pickers"

const ITEM =
  "flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-ui font-medium text-foreground outline-none transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover max-lg:min-h-11"

export function DueDatePopover({
  value,
  onChange,
  variant = "ghost",
  disabled,
  className,
}: {
  value: string | null
  onChange: (due: string | null) => void
  variant?: PickerVariant
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const { anchorRef, contentRef, style } = useAnchoredPosition(open)
  const due = toDueDateValue(value)
  const dueDate = parseDueDate(due)
  const label = formatDue(due)
  const empty = variant === "pill" ? "Due date" : "No due date"
  const text = label ? `${label.text}, ${formatShortDate(dueDate)}` : empty

  const today = startOfDay(new Date())
  const tomorrow = addDays(today, 1)
  const nextWeek = addDays(startOfWeek(today), 7)
  const shortcuts = [
    { label: "Today", day: today, hint: formatWeekdayShort(today) },
    { label: "Tomorrow", day: tomorrow, hint: formatWeekdayShort(tomorrow) },
    { label: "Next week", day: nextWeek, hint: `${formatWeekdayShort(nextWeek)} ${formatShortDate(nextWeek)}` },
  ]

  const change = (next: string | null) => {
    if (next !== due) onChange(next)
  }

  const choose = (day: Date | null) => {
    change(day ? toDueDateValue(day) : null)
    setOpen(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal={false}>
      <Dialog.Trigger asChild disabled={disabled}>
        <button
          ref={anchorRef}
          type="button"
          aria-label={`Due date: ${text}`}
          title={dueDate ? `Due ${formatShortDate(dueDate)}` : undefined}
          className={cn(PICKER_TRIGGER, PICKER_VARIANT[variant], className)}
        >
          <Calendar aria-hidden="true" className="size-[1rem] shrink-0 text-muted-foreground" />
          {label ? (
            <span
              className={cn(
                "truncate",
                label.tone === "overdue" && "text-app-berry-text",
                label.tone === "today" && "rounded-full bg-app-lemon-soft px-2 text-app-lemon-ink",
              )}
            >
              {label.text}
            </span>
          ) : (
            <span className="truncate text-muted-foreground">{empty}</span>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Content
          ref={contentRef}
          aria-describedby={undefined}
          style={style}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const content = event.currentTarget as HTMLElement
            content.querySelector<HTMLElement>('[role="grid"] [tabindex="0"]')?.focus()
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            "fixed z-50 flex max-h-[calc(100dvh-1rem)] w-[17rem] flex-col overflow-y-auto p-1 max-lg:w-[19rem]",
            POPOVER_SURFACE,
          )}
        >
          <Dialog.Title className="sr-only">Due date</Dialog.Title>
          <div className="flex flex-col">
            {shortcuts.map((shortcut) => (
              <button key={shortcut.label} type="button" onClick={() => choose(shortcut.day)} className={ITEM}>
                {shortcut.label}
                <span className="text-caption font-medium text-muted-foreground tabular-nums">{shortcut.hint}</span>
              </button>
            ))}
          </div>
          <div role="separator" className="mx-1.5 my-1 h-[0.0625rem] shrink-0 bg-border" />
          <MiniMonth key={due ?? "none"} value={dueDate} onSelect={choose} today={today} className="px-1" />
          <div role="separator" className="mx-1.5 my-1 h-[0.0625rem] shrink-0 bg-border" />
          <div className="flex flex-col gap-1 px-1 pb-0.5">
            <DateInput
              aria-label="Type a due date"
              value={due}
              onChange={(next) => change(toDueDateValue(next))}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                event.preventDefault()
                setOpen(false)
              }}
              className="h-[2rem] text-ui max-lg:h-11"
            />
            {due && (
              <button type="button" onClick={() => choose(null)} className={ITEM}>
                Clear due date
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
