import { useRef, type KeyboardEvent } from "react"
import { Prohibit, type IconComponent } from "@/components/icons"
import { FOLDER_COLORS, type FolderColor } from "@/lib/folderColors"
import { nearestSwatch } from "@/lib/projectColors"
import { cn } from "@/lib/utils"
import { SYMBOLS, symbolFor, type SymbolKey } from "./symbols"

const RING = "shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--color-text)_14%,transparent)]"

const SIZES = {
  sm: { tile: "size-[1.0625rem] rounded-xs text-micro", square: "size-[0.6rem] rounded-xs", weight: "bold" },
  md: { tile: "size-[1.5rem] rounded-sm text-caption", square: "size-[1.1rem] rounded-sm", weight: "bold" },
  lg: { tile: "size-[2.25rem] rounded-md text-ui", square: "size-[1.5rem] rounded-sm", weight: "bold" },
} as const

/** A folder colour key is a group chat's, anything else a project's hex */
function tileColor(color: string | null | undefined): string {
  if (FOLDER_COLORS.includes(color as FolderColor)) return `var(--color-${color})`
  return nearestSwatch(color).hex
}

/** A chosen symbol in its colour. Without one, a colour tile with the first letter of `label`, or a plain coloured square */
export function IdentityTile({
  color,
  symbol,
  size,
  label,
  className,
}: {
  color: string | null | undefined
  symbol: string | null | undefined
  size: "sm" | "md" | "lg"
  label?: string
  className?: string
}) {
  const entry = symbolFor(symbol)
  const step = SIZES[size]
  const fill = tileColor(color)
  const background = { backgroundColor: fill }
  if (entry) {
    // A chosen symbol stands on its own, drawn in the chosen colour
    return (
      <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center", step.tile, className)}>
        <entry.Icon weight="fill" className="size-full" style={{ color: fill }} />
      </span>
    )
  }
  if (!label) {
    return (
      <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center", step.tile, className)}>
        <span className={cn(step.square, RING)} style={background} />
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      style={background}
      className={cn("flex shrink-0 items-center justify-center leading-none font-semibold text-app-on-accent", step.tile, RING, className)}
    >
      {label.trim().charAt(0).toUpperCase() || "#"}
    </span>
  )
}

const STEP = new Map([
  ["ArrowRight", 1],
  ["ArrowDown", 1],
  ["ArrowLeft", -1],
  ["ArrowUp", -1],
])

const OPTIONS: { key: SymbolKey | null; label: string; Icon: IconComponent }[] = [
  { key: null, label: "No symbol", Icon: Prohibit },
  ...SYMBOLS,
]

/** A radio grid of every symbol, "No symbol" first */
export function SymbolPicker({
  value,
  onChange,
  labelledBy,
  disabled = false,
}: {
  value: SymbolKey | null
  onChange: (symbol: SymbolKey | null) => void
  labelledBy: string
  disabled?: boolean
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = Math.max(
    0,
    OPTIONS.findIndex((option) => option.key === value),
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = OPTIONS.length
    const step = STEP.get(event.key)
    const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : step === undefined ? null : (selected + step + count) % count
    if (next === null) return
    event.preventDefault()
    onChange(OPTIONS[next].key)
    buttons.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      onKeyDown={disabled ? undefined : onKeyDown}
      className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-0.5 lg:grid-cols-[repeat(auto-fill,2rem)]"
    >
      {OPTIONS.map(({ key, label, Icon }, i) => {
        const active = i === selected
        return (
          <button
            key={key ?? "none"}
            ref={(el) => {
              buttons.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(key)}
            className={cn(
              "flex h-[2.75rem] items-center justify-center rounded-md transition-colors duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 lg:size-[2rem]",
              active ? "bg-app-selected text-foreground" : "text-muted-foreground enabled:hover:bg-app-hover enabled:hover:text-foreground",
            )}
          >
            <Icon aria-hidden="true" weight={active ? "bold" : "regular"} className="size-[1.125rem] lg:size-[1rem]" />
          </button>
        )
      })}
    </div>
  )
}
