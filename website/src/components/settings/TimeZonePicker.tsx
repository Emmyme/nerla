import { useId, useMemo, useState, type KeyboardEvent } from "react"
import { ChevronDown } from "@/components/icons"
import { Input } from "@/components/ui/input"
import { deviceTimeZone, zoneOffsetMinutes } from "@/lib/dates"
import { cn } from "@/lib/utils"

const MAX_SHOWN = 60

export const zoneLabel = (zone: string) => zone.replace(/_/g, " ").replace(/\//g, " / ")

function allZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone")
  } catch {
    return [deviceTimeZone(), "UTC"]
  }
}

function offsetText(zone: string, now: Date): string {
  const minutes = zoneOffsetMinutes(now, zone)
  if (minutes === null) return ""
  if (minutes === 0) return "UTC"
  const sign = minutes > 0 ? "+" : "-"
  const abs = Math.abs(minutes)
  const rest = abs % 60
  return `UTC${sign}${Math.floor(abs / 60)}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`
}

const normalize = (text: string) => text.toLowerCase().replace(/[_/]+/g, " ").replace(/\s+/g, " ").trim()

/** A searchable list of IANA time zones, typed into like a field */
export function TimeZonePicker({ id, value, onChange }: { id: string; value: string; onChange: (zone: string) => void }) {
  const listId = useId()
  const [query, setQuery] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const zones = useMemo(() => {
    const now = new Date()
    const names = allZones()
    if (value && !names.includes(value)) names.unshift(value)
    return names.map((zone) => ({ zone, label: zoneLabel(zone), search: normalize(zone), offset: offsetText(zone, now) }))
  }, [value])

  const term = normalize(query ?? "")
  const shown = (
    term ? zones.filter((item) => item.search.includes(term) || item.offset.toLowerCase() === term.replace(/\s/g, "")) : zones
  ).slice(0, MAX_SHOWN)

  const pick = (zone: string) => {
    onChange(zone)
    setQuery(null)
    setOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(
          Math.max(
            0,
            shown.findIndex((item) => item.zone === value),
          ),
        )
        return
      }
      const step = event.key === "ArrowDown" ? 1 : -1
      setActive((index) => (index + step + shown.length) % Math.max(shown.length, 1))
    } else if (event.key === "Enter") {
      if (!open) return
      event.preventDefault()
      const item = shown[active]
      if (item) pick(item.zone)
    } else if (event.key === "Escape" && open) {
      event.preventDefault()
      event.stopPropagation()
      setQuery(null)
      setOpen(false)
    }
  }

  const activeId = open && shown[active] ? `${listId}-${active}` : undefined
  const current = zones.find((item) => item.zone === value)

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        value={query ?? (current ? current.label : "")}
        placeholder="Search time zones"
        onFocus={(event) => event.currentTarget.select()}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
          setOpen(true)
        }}
        onBlur={() => {
          setQuery(null)
          setOpen(false)
        }}
        onKeyDown={onKeyDown}
        className="pr-16"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center gap-1.5 text-caption text-muted-foreground"
      >
        {query === null && current?.offset}
        <ChevronDown className="size-3.5 opacity-60" />
      </span>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Time zones"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-md border-[0.0625rem] border-border bg-popover p-1 shadow-[var(--shadow-popover)]"
        >
          {shown.length === 0 ? (
            <li className="px-2.5 py-1.5 text-ui text-muted-foreground">No time zones found</li>
          ) : (
            shown.map((item, index) => (
              <li
                key={item.zone}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={item.zone === value}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(item.zone)}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-ui text-foreground max-lg:min-h-11",
                  index === active && "bg-app-hover",
                  item.zone === value && "bg-app-selected",
                )}
              >
                <span className="min-w-0 truncate">{item.label}</span>
                <span className="shrink-0 text-caption text-muted-foreground tabular-nums">{item.offset}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
