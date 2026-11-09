import { useId, useRef, useState } from "react"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { RadioList } from "@/components/ui/radio-list"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { addMonths, formatWeekdayLong, startOfDay } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { DateField } from "./DateField"
import { FIELD } from "./EventFields"
import { recurrenceText } from "./items"
import {
  clamp,
  customFrom,
  customRule,
  PRESETS,
  presetLabel,
  presetOf,
  presetRule,
  WEEKDAYS,
  type CustomRecurrence,
  type Frequency,
  type RecurrenceEnd,
} from "./recurrence"

const CURRENT = "current"
const CUSTOM = "custom"
const UNITS: { value: Frequency; one: string; many: string }[] = [
  { value: "DAILY", one: "day", many: "days" },
  { value: "WEEKLY", one: "week", many: "weeks" },
  { value: "MONTHLY", one: "month", many: "months" },
  { value: "YEARLY", one: "year", many: "years" },
]
// 5 January 2026 is a Monday
const weekdayDate = (index: number) => new Date(2026, 0, 5 + index)

/** Google's repeat menu: presets from the start date, and Custom in a small dialog */
export function RecurrencePicker({ rule, start, onChange }: { rule: string | null; start: Date; onChange: (rule: string | null) => void }) {
  const [custom, setCustom] = useState<CustomRecurrence | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const preset = presetOf(rule, start)
  const value = preset === "custom" ? CURRENT : preset

  return (
    <>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === CUSTOM) setCustom(customFrom(rule, start))
          else if (next !== CURRENT) onChange(presetRule(next as (typeof PRESETS)[number], start))
        }}
      >
        <SelectTrigger ref={trigger} aria-label="Repeat" className="min-w-0 px-2.5">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((option) => (
            <SelectItem key={option} value={option} className="text-ui">
              {presetLabel(option, start)}
            </SelectItem>
          ))}
          {preset === "custom" && rule && (
            <SelectItem value={CURRENT} className="text-ui">
              {recurrenceText(rule, start)}
            </SelectItem>
          )}
          <SelectItem value={CUSTOM} className="text-ui">
            Custom
          </SelectItem>
        </SelectContent>
      </Select>
      {custom && (
        <CustomDialog
          initial={custom}
          start={start}
          fallbackFocus={() => trigger.current}
          onClose={() => setCustom(null)}
          onDone={(next) => {
            setCustom(null)
            onChange(customRule(next, start))
          }}
        />
      )}
    </>
  )
}

const settle = (text: string) => clamp(Number(text))

function CustomDialog({
  initial,
  start,
  fallbackFocus,
  onClose,
  onDone,
}: {
  initial: CustomRecurrence
  start: Date
  fallbackFocus: () => HTMLElement | null
  onClose: () => void
  onDone: (custom: CustomRecurrence) => void
}) {
  const [form, setForm] = useState(initial)
  const [endKind, setEndKind] = useState<RecurrenceEnd["kind"]>(initial.end.kind)
  const [untilDay, setUntilDay] = useState(() => (initial.end.kind === "on" ? initial.end.date : startOfDay(addMonths(start, 3))))
  // Number fields keep what is typed, so they can be cleared, and settle on blur or Done
  const [intervalText, setIntervalText] = useState(String(initial.interval))
  const [countText, setCountText] = useState(String(initial.end.kind === "after" ? initial.end.count : 13))
  const id = useId()
  const interval = settle(intervalText)
  const count = settle(countText)
  const untilBeforeStart = endKind === "on" && untilDay < startOfDay(start)
  const end: RecurrenceEnd =
    endKind === "on" ? { kind: "on", date: untilDay } : endKind === "after" ? { kind: "after", count } : { kind: "never" }

  const toggleDay = (day: (typeof WEEKDAYS)[number]) => {
    const has = form.weekdays.includes(day)
    if (has && form.weekdays.length === 1) return
    setForm({ ...form, weekdays: has ? form.weekdays.filter((other) => other !== day) : [...form.weekdays, day] })
  }

  return (
    <BaseModal isOpen onClose={onClose} title="Custom recurrence" maxWidth="sm" showCloseButton={false} fallbackFocus={fallbackFocus}>
      <form
        className="flex flex-col gap-5 p-6"
        onSubmit={(event) => {
          // The dialog sits inside the editor form in React, so its submit must not reach that form
          event.preventDefault()
          event.stopPropagation()
          if (!untilBeforeStart) onDone({ ...form, interval, end })
        }}
      >
        <div className="flex flex-wrap items-center gap-2 text-body text-foreground">
          <label htmlFor={`${id}-interval`}>Repeat every</label>
          <input
            id={`${id}-interval`}
            type="number"
            min={1}
            max={999}
            value={intervalText}
            onChange={(e) => setIntervalText(e.target.value)}
            onBlur={() => setIntervalText(String(interval))}
            className={cn(FIELD, "w-[4.5rem]")}
          />
          <Select value={form.freq} onValueChange={(freq) => setForm({ ...form, freq: freq as Frequency })}>
            <SelectTrigger aria-label="Repeat unit" className="w-[7rem] px-2.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UNITS.map((option) => (
                <SelectItem key={option.value} value={option.value} className="text-ui">
                  {interval === 1 ? option.one : option.many}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {form.freq === "WEEKLY" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-body text-foreground">Repeat on</legend>
            <div className="flex flex-wrap gap-1">
              {WEEKDAYS.map((day, index) => {
                const on = form.weekdays.includes(day)
                const name = formatWeekdayLong(weekdayDate(index))
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    aria-label={name}
                    title={name}
                    onClick={() => toggleDay(day)}
                    className={cn(
                      "flex size-[2rem] items-center justify-center rounded-full text-caption font-medium transition-colors duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:size-10",
                      on ? "bg-app-sky text-app-sky-ink" : "bg-app-sunk text-muted-foreground hover:bg-app-hover hover:text-foreground",
                    )}
                  >
                    {name.charAt(0)}
                  </button>
                )
              })}
            </div>
          </fieldset>
        )}

        {form.freq === "MONTHLY" && <p className="text-ui text-muted-foreground">{presetLabel("monthly", start)}</p>}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-body text-foreground">Ends</legend>
          <RadioList
            name={`${id}-end`}
            value={endKind}
            onChange={setEndKind}
            options={[
              { value: "never", label: "Never" },
              {
                value: "on",
                label: "On",
                control: (
                  <DateField
                    label="Ends on"
                    value={untilDay}
                    invalid={untilBeforeStart}
                    onChange={(day) => {
                      setUntilDay(day)
                      setEndKind("on")
                    }}
                    className="w-[9rem]"
                  />
                ),
              },
              {
                value: "after",
                label: "After",
                control: (
                  <>
                    <input
                      type="number"
                      aria-label="Number of occurrences"
                      min={1}
                      max={999}
                      value={countText}
                      onChange={(e) => {
                        setCountText(e.target.value)
                        setEndKind("after")
                      }}
                      onBlur={() => setCountText(String(count))}
                      className={cn(FIELD, "w-[4.5rem]")}
                    />
                    <span>{count === 1 ? "occurrence" : "occurrences"}</span>
                  </>
                ),
              },
            ]}
          />
          {untilBeforeStart && <p className="text-caption text-app-berry-text">Pick an end date after the start</p>}
        </fieldset>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Done</Button>
        </div>
      </form>
    </BaseModal>
  )
}
