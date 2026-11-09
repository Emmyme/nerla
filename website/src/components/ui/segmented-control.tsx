import { useRef, type KeyboardEvent, type ReactNode } from "react"
import { cn } from "@/lib/utils"

export type SegmentedOption<T extends string> = { value: T; label: string; icon?: ReactNode }

const STEP = new Map([
  ["ArrowRight", 1],
  ["ArrowDown", 1],
  ["ArrowLeft", -1],
  ["ArrowUp", -1],
])

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  iconOnly = false,
}: {
  value: T
  onChange: (value: T) => void
  options: SegmentedOption<T>[]
  label: string
  className?: string
  /** Shows only each option's icon, with its label for screen readers and as a tooltip */
  iconOnly?: boolean
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = options.findIndex((option) => option.value === value)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = options.length - 1
    const step = STEP.get(e.key)
    let next: number
    if (e.key === "Home") next = 0
    else if (e.key === "End") next = last
    else if (step === undefined) return
    else if (selected === -1) next = step > 0 ? 0 : last
    else next = (selected + step + options.length) % options.length
    e.preventDefault()
    onChange(options[next].value)
    buttons.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("inline-flex items-center gap-0.5 rounded-lg bg-app-sunk p-0.5", className)}
    >
      {options.map((option, i) => {
        const active = i === selected
        return (
          <button
            key={option.value}
            ref={(el) => {
              buttons.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || (selected === -1 && i === 0) ? 0 : -1}
            aria-label={iconOnly ? option.label : undefined}
            title={iconOnly ? option.label : undefined}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-ui font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-lg:min-h-11",
              iconOnly && "h-7 w-8 justify-center px-0 py-0 max-lg:min-w-11",
              active ? "bg-card text-foreground ring-[0.0625rem] ring-border" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.icon}
            {!iconOnly && option.label}
          </button>
        )
      })}
    </div>
  )
}
