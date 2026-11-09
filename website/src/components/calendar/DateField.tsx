import { useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { POPOVER_SURFACE, useAnchoredPosition } from "@/components/ui/anchored-popover"
import { MiniMonth } from "@/components/ui/mini-month"
import { formatShortDate, formatWeekdayShort, startOfDay } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { FIELD } from "./EventFields"

/** A date as a button, "Fri 23 Oct", that opens a month to pick from */
export function DateField({
  value,
  onChange,
  label,
  invalid,
  className,
}: {
  value: Date
  onChange: (day: Date) => void
  label: string
  invalid?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const { anchorRef, contentRef, style } = useAnchoredPosition(open)
  const text = `${formatWeekdayShort(value)} ${formatShortDate(value)}`

  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal={false}>
      <Dialog.Trigger asChild>
        <button
          ref={anchorRef}
          type="button"
          aria-label={`${label}, ${text}`}
          aria-invalid={invalid || undefined}
          className={cn(FIELD, "text-left", className)}
        >
          {text}
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
          className={cn("fixed z-50 w-[17rem] p-2 max-lg:w-[19rem]", POPOVER_SURFACE)}
        >
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          <MiniMonth
            key={value.getTime()}
            value={startOfDay(value)}
            onSelect={(day) => {
              onChange(day)
              setOpen(false)
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
