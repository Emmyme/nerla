import { useId } from "react"
import { EVENT_FILL, EVENT_MARK, EVENT_TYPE_OPTIONS, eventTone, type EventType } from "@/lib/eventColors"
import { useTypeShapes } from "@/lib/typeShapes"
import { cn } from "@/lib/utils"
import { MARK_RING, OooMark } from "./EventBlock"
import { GLYPH_INK, TypeGlyph } from "./TypeGlyph"

export const FIELD =
  "h-8 min-w-0 rounded-md border-[0.0625rem] border-input bg-card px-2.5 text-ui text-foreground tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring aria-invalid:border-app-berry max-lg:h-11"

/** Room for a 24 hour time such as "23:45" */
export const TIME_FIELD = "w-[5.5rem] min-w-[5.5rem]"

export function Toggle({
  checked,
  onChange,
  label,
  id,
  describedBy,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  id?: string
  /** The id of text that says what the switch does */
  describedBy?: string
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[1.25rem] w-[2.25rem] shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:ring-offset-[0.125rem] focus-visible:ring-offset-popover focus-visible:outline-none",
        // Off keeps a field's edge, so the switch stands out from what it sits on
        checked ? "bg-app-join" : "bg-app-sunk ring-[0.0625rem] ring-input ring-inset",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-[0.15rem] size-[0.95rem] rounded-full bg-card shadow-[0_0_0_0.0625rem_color-mix(in_srgb,var(--color-text)_12%,transparent)] transition-transform duration-150",
          checked && "translate-x-[1rem]",
        )}
      />
    </button>
  )
}

/** The event type as pills in its tone, a dot on the ones not picked. With shapes on, each shows its shape */
export function TypePills({ value, onChange }: { value: EventType; onChange: (type: EventType) => void }) {
  const name = useId()
  const shapes = useTypeShapes()
  return (
    <fieldset className="flex flex-wrap gap-1">
      <legend className="sr-only">Type</legend>
      {EVENT_TYPE_OPTIONS.map(({ type, label }) => {
        const tone = eventTone(type)
        const checked = value === type
        return (
          <label
            key={type}
            className={cn(
              "relative flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-caption font-medium transition-colors duration-150 has-[:focus-visible]:outline-[0.125rem] has-[:focus-visible]:outline-offset-[0.0625rem] has-[:focus-visible]:outline-ring max-lg:py-2",
              checked
                ? EVENT_FILL[tone]
                : "text-muted-foreground ring-[0.0625rem] ring-border ring-inset hover:bg-app-hover hover:text-foreground",
            )}
          >
            <input type="radio" name={name} value={type} checked={checked} onChange={() => onChange(type)} className="sr-only" />
            {shapes ? (
              <TypeGlyph type={type} className={cn("size-[0.8rem]", !checked && GLYPH_INK[tone])} />
            ) : (
              !checked &&
              (type === "ooo" ? (
                <OooMark className="size-[0.5rem]" />
              ) : (
                <span aria-hidden="true" className={cn("size-[0.5rem] rounded-full", EVENT_MARK[tone].bg, MARK_RING)} />
              ))
            )}
            {label}
          </label>
        )
      })}
    </fieldset>
  )
}
