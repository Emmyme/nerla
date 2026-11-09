import { useState } from "react"
import { toast } from "sonner"
import { Check, ChevronLeft, ChevronRight, Refresh } from "@/components/icons"
import { PresenceCat } from "@/components/ui/presence-cat"
import { formatUntil } from "@/lib/availability"
import { deviceTimeZone, sameDay } from "@/lib/dates"
import { PRESENCE_WORD, presenceState, type PresenceState, type StatusChoice } from "@/lib/presence"
import { setOwnStatus, useOwnStatus, usePresenceEntry } from "@/lib/presenceStore"
import {
  CLEAR_OPTIONS,
  STATUS_OPTIONS,
  clearAfterOf,
  clearAt,
  defaultClearAfter,
  type ClearAfter,
  type StatusOption,
} from "@/lib/statusChoice"
import { messageOf } from "@/lib/taskStore"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"

type Variant = "menu" | "sheet"

// The clear after picked last, so it stays checked when the menu opens again
let remembered: { until: string | null; clear: ClearAfter } | null = null

function useOwnState(): PresenceState | null {
  const { user } = useAuth()
  const entry = usePresenceEntry(user?.id, true)
  return entry ? presenceState(entry, new Date()) : null
}

function itemProps(variant: Variant, checked?: boolean) {
  if (variant === "menu") {
    return checked === undefined ? { role: "menuitem", tabIndex: -1 } : { role: "menuitemradio", "aria-checked": checked, tabIndex: -1 }
  }
  return checked === undefined ? {} : { "aria-pressed": checked }
}

/** The row that opens the status choices, with the user's own cat and the word other users see */
export function StatusRow({
  variant,
  className,
  iconClass,
  onOpen,
}: {
  variant: Variant
  className: string
  iconClass: string
  onOpen: () => void
}) {
  const state = useOwnState()
  const choice = useOwnStatus()
  const word = choice?.value === "offline" ? "Appear offline" : state ? PRESENCE_WORD[state] : "Status"
  return (
    <button
      type="button"
      {...itemProps(variant)}
      aria-haspopup="true"
      aria-label={`Status, ${word.toLowerCase()}`}
      className={className}
      onClick={onOpen}
    >
      <span aria-hidden="true" className={cn(iconClass, "flex items-center justify-center")}>
        {state && <PresenceCat state={state} size={variant === "sheet" ? "xl" : "lg"} className="-m-0.5" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{word}</span>
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  )
}

// Each choice shows its cat at 1.5rem, and the row keeps its height
const SLOT = "-my-1 flex size-[1.5rem] shrink-0 items-center justify-center"

function clearCaption(choice: StatusChoice, now: Date): string | null {
  if (!choice.until) return null
  const until = new Date(choice.until)
  const zone = deviceTimeZone()
  return sameDay(until, now) ? `Clears at ${formatUntil(until, now, zone)}` : `Clears ${formatUntil(until, now, zone)}`
}

/** The status choices and when they clear, applied as they are picked */
export function StatusChoices({
  variant,
  itemClass,
  iconClass,
  labelClass,
  separator,
  onBack,
}: {
  variant: Variant
  itemClass: string
  iconClass: string
  labelClass: string
  separator: string
  onBack: () => void
}) {
  const choice = useOwnStatus()
  const [saving, setSaving] = useState(false)
  const now = new Date()
  const current: StatusOption = choice?.value ?? "auto"
  const clear = choice ? (remembered && remembered.until === choice.until ? remembered.clear : clearAfterOf(choice.until, now)) : null

  const apply = async (value: StatusOption, after: ClearAfter) => {
    if (saving) return
    setSaving(true)
    try {
      const status = await setOwnStatus(value, value === "auto" ? null : clearAt(after, new Date()))
      remembered = status ? { until: status.until, clear: after } : null
    } catch (err) {
      toast.error(messageOf(err, "Could not set your status"))
    } finally {
      setSaving(false)
    }
  }

  const check = (checked: boolean) => (
    <Check aria-hidden="true" weight="bold" className={cn("ml-auto size-3.5 shrink-0", !checked && "invisible")} />
  )
  const caption = choice && clearCaption(choice, now)

  return (
    <>
      <button type="button" {...itemProps(variant)} className={cn(itemClass, "text-muted-foreground")} onClick={onBack}>
        <span aria-hidden="true" className={SLOT}>
          <ChevronLeft className={iconClass} />
        </span>
        Back
      </button>
      <div role="separator" className={separator} />
      <div role="group" aria-label="Status" aria-busy={saving || undefined}>
        <p aria-hidden="true" className={labelClass}>
          Status
        </p>
        {STATUS_OPTIONS.map(({ value, label, cat }) => {
          const checked = current === value
          return (
            <button
              key={value}
              type="button"
              {...itemProps(variant, checked)}
              className={itemClass}
              onClick={() => void apply(value, defaultClearAfter(value))}
            >
              <span aria-hidden="true" className={SLOT}>
                {cat ? <PresenceCat state={cat} size="xl" /> : <Refresh className={iconClass} />}
              </span>
              {label}
              {check(checked)}
            </button>
          )
        })}
      </div>
      {choice && (
        <>
          <div role="separator" className={separator} />
          <div role="group" aria-label="Clear after">
            <p aria-hidden="true" className={labelClass}>
              Clear after
            </p>
            {CLEAR_OPTIONS.map(({ value, label }) => {
              const checked = clear === value
              return (
                <button
                  key={value}
                  type="button"
                  {...itemProps(variant, checked)}
                  className={itemClass}
                  onClick={() => void apply(current, value)}
                >
                  <span aria-hidden="true" className={SLOT} />
                  {label}
                  {check(checked)}
                </button>
              )
            })}
            {caption && <p className={cn(labelClass, "pb-1.5")}>{caption}</p>}
          </div>
        </>
      )}
    </>
  )
}
