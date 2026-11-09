import { useRef, type KeyboardEvent } from "react"
import { Check } from "@/components/icons"
import { nearestSwatch, PROJECT_SWATCHES, type ProjectSwatchKey } from "@/lib/projectColors"
import { cn } from "@/lib/utils"

export const SWATCH_NAMES: Record<ProjectSwatchKey, string> = {
  pistachio: "Pistachio",
  "pistachio-deep": "Deep pistachio",
  bubblegum: "Bubblegum",
  "bubblegum-deep": "Deep bubblegum",
  sky: "Sky",
  "sky-deep": "Deep sky",
  lavender: "Lavender",
  "lavender-deep": "Deep lavender",
}

const STEP = new Map([
  ["ArrowRight", 1],
  ["ArrowDown", 1],
  ["ArrowLeft", -1],
  ["ArrowUp", -1],
])

function selectedIndex(value: string | null): number {
  if (!value) return -1
  const exact = PROJECT_SWATCHES.findIndex((swatch) => swatch.hex.toLowerCase() === value.toLowerCase())
  if (exact !== -1) return exact
  const near = nearestSwatch(value).key
  return PROJECT_SWATCHES.findIndex((swatch) => swatch.key === near)
}

export function SwatchPicker({
  value,
  onChange,
  labelledBy,
  disabled = false,
}: {
  value: string | null
  onChange: (hex: string) => void
  labelledBy?: string
  disabled?: boolean
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = selectedIndex(value)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const count = PROJECT_SWATCHES.length
    const step = STEP.get(e.key)
    let next: number
    if (e.key === "Home") next = 0
    else if (e.key === "End") next = count - 1
    else if (step === undefined) return
    else if (selected === -1) next = step > 0 ? 0 : count - 1
    else next = (selected + step + count) % count
    e.preventDefault()
    onChange(PROJECT_SWATCHES[next].hex)
    buttons.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : "Color"}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      onKeyDown={disabled ? undefined : onKeyDown}
      className="inline-grid w-max grid-cols-4 gap-1 lg:grid-cols-8"
    >
      {PROJECT_SWATCHES.map((swatch, i) => {
        const active = i === selected
        return (
          <button
            key={swatch.key}
            ref={(el) => {
              buttons.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={SWATCH_NAMES[swatch.key]}
            title={SWATCH_NAMES[swatch.key]}
            tabIndex={active || (selected === -1 && i === 0) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(swatch.hex)}
            className="group flex size-[2.75rem] items-center justify-center rounded-full focus-visible:outline-none disabled:cursor-not-allowed lg:size-[2rem]"
          >
            <span
              aria-hidden="true"
              style={{ backgroundColor: swatch.hex }}
              className={cn(
                "flex size-[2.125rem] items-center justify-center rounded-full transition-transform duration-150 group-focus-visible:outline-[0.125rem] group-focus-visible:outline-offset-[0.3125rem] group-focus-visible:outline-ring lg:size-[1.5rem]",
                active
                  ? "ring-[0.125rem] ring-foreground ring-offset-[0.125rem] ring-offset-card"
                  : "shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--color-text)_14%,transparent)] group-enabled:group-hover:scale-110",
              )}
            >
              {active && <Check weight="bold" className="size-[0.875rem] text-app-on-accent lg:size-[0.75rem]" />}
            </span>
          </button>
        )
      })}
    </div>
  )
}
