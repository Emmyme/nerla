import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react"
import { durationText, parseTimeOfDay, stepTimeOfDay, timeOptions, toMinutes } from "@/lib/timeOfDay"
import { cn, remPx } from "@/lib/utils"

const HIDDEN: CSSProperties = { visibility: "hidden", top: 0, left: 0 }

const FIELD =
  "h-8 min-w-0 rounded-md border-[0.0625rem] border-input bg-card px-2.5 text-ui text-foreground tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring aria-invalid:border-app-berry max-lg:h-11"

/**
 * A time of day on the 24 hour clock, typed ("930" is 09:30, "14" is 14:00) or picked from a list at the step.
 * Up and down step the time. `durationFrom` makes it an end time, whose list starts there and shows the length.
 */
export function TimeField({
  value,
  onChange,
  step = 15,
  durationFrom,
  id,
  className,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  value: string
  onChange: (value: string) => void
  /** Minutes between the times in the list and per arrow press */
  step?: number
  durationFrom?: string
  id?: string
  className?: string
  "aria-label": string
  "aria-invalid"?: boolean
  "aria-describedby"?: string
}) {
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [text, setText] = useState(value)
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<CSSProperties>(HIDDEN)

  useEffect(() => {
    if (!editing) setText(value)
  }, [value, editing])

  const typed = parseTimeOfDay(text)
  const bad = editing && text.trim() !== "" && typed === null
  const from = durationFrom ? toMinutes(durationFrom) : null
  const options = useMemo(() => timeOptions(step, from ?? 0), [step, from])
  const target = typed ?? value
  const targetMinutes = toMinutes(target) ?? 0
  // The time itself when it is in the list, otherwise the next one after it
  const highlighted =
    options.find((option) => option === target) ?? options.find((option) => (toMinutes(option) ?? 0) >= targetMinutes) ?? options[0]

  const commit = (next: string) => {
    setText(next)
    setEditing(false)
    if (next !== value) onChange(next)
  }

  const finish = () => {
    if (typed) commit(typed)
    else {
      setText(value)
      setEditing(false)
    }
    setOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (event.altKey) return setOpen(event.key === "ArrowDown")
      commit(stepTimeOfDay(target, event.key === "ArrowDown" ? -1 : 1, step))
    } else if (event.key === "Enter") {
      if (!open && !editing) return
      event.preventDefault()
      finish()
    } else if (event.key === "Escape" && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      setText(value)
      setEditing(false)
    }
  }

  // Fixed to the field. The offset makes up for an ancestor with a transform, which moves the fixed origin.
  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      const field = input.current
      const box = list.current
      if (!field || !box) return
      const rem = remPx()
      const shown = box.getBoundingClientRect()
      const origin = { top: shown.top - (parseFloat(box.style.top) || 0) * rem, left: shown.left - (parseFloat(box.style.left) || 0) * rem }
      const rect = field.getBoundingClientRect()
      const gap = 0.25 * rem
      const below = window.innerHeight - rect.bottom - gap
      const height = box.offsetHeight
      const top = below >= height || below >= rect.top ? rect.bottom + gap : rect.top - gap - height
      const left = Math.min(rect.left, window.innerWidth - box.offsetWidth - 0.5 * rem)
      setPlace({
        top: `${(top - origin.top) / rem}rem`,
        left: `${(Math.max(0.5 * rem, left) - origin.left) / rem}rem`,
        minWidth: `${rect.width / rem}rem`,
      })
    }
    position()
    window.addEventListener("resize", position)
    window.addEventListener("scroll", position, true)
    return () => {
      window.removeEventListener("resize", position)
      window.removeEventListener("scroll", position, true)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" })
  }, [open, highlighted])

  useEffect(() => {
    if (!open) setPlace(HIDDEN)
  }, [open])

  return (
    <>
      <input
        ref={input}
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${highlighted}` : undefined}
        aria-invalid={ariaInvalid || bad || undefined}
        aria-describedby={ariaDescribedBy}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setEditing(true)
          setOpen(true)
        }}
        onFocus={(event) => event.currentTarget.select()}
        onClick={() => setOpen(true)}
        onBlur={finish}
        onKeyDown={onKeyDown}
        className={cn(FIELD, "w-[5.5rem]", className)}
      />
      {open && (
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          style={place}
          // The field keeps focus, so a press on the list never blurs it
          onMouseDown={(event) => event.preventDefault()}
          className="fixed z-60 max-h-[14rem] overflow-y-auto overscroll-contain rounded-lg border-[0.0625rem] border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-popover)]"
        >
          {options.map((option) => {
            const selected = option === highlighted
            const length = durationFrom ? durationText(durationFrom, option) : null
            return (
              <div
                key={option}
                id={`${listId}-${option}`}
                role="option"
                aria-selected={selected}
                onClick={() => {
                  commit(option)
                  setOpen(false)
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-ui whitespace-nowrap text-foreground tabular-nums hover:bg-app-hover max-lg:py-2.5",
                  selected && "bg-app-selected hover:bg-app-selected",
                )}
              >
                {option}
                {length && <span className="text-caption text-muted-foreground">{length}</span>}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
