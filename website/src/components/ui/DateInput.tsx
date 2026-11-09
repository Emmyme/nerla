import { useState, useEffect, useRef, useId } from "react"
import { Calendar } from "@/components/icons"
import { Input } from "@/components/ui/input"
import { FieldError } from "@/components/ui/field-error"
import { cn } from "@/lib/utils"
import { toDueDateValue } from "@/lib/dates"

// The field shows DD-MM-YYYY and reports the YYYY-MM-DD calendar day, never a UTC instant
const toDisplay = (value: string | null | undefined) => toDueDateValue(value)?.split("-").reverse().join("-") ?? ""
const fromDisplay = (text: string) => toDueDateValue(text.split("-").reverse().join("-"))

interface DateInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> {
  value?: string | null
  onChange?: (value: string) => void
  error?: string
}

export function DateInput({ value, onChange, error, className = "", disabled, ...props }: DateInputProps) {
  const [displayValue, setDisplayValue] = useState("")
  const hiddenInputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()

  useEffect(() => {
    setDisplayValue(toDisplay(value))
    if (hiddenInputRef.current) hiddenInputRef.current.value = toDueDateValue(value) ?? ""
  }, [value])

  const handleDisplayChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let input = e.target.value.replace(/\D/g, "")

    if (input.length > 4) {
      input = `${input.slice(0, 2)}-${input.slice(2, 4)}-${input.slice(4, 8)}`
    } else if (input.length > 2) {
      input = `${input.slice(0, 2)}-${input.slice(2)}`
    }

    setDisplayValue(input)

    if (input.length === 10) {
      const day = fromDisplay(input)
      if (day) onChange?.(day)
    } else if (input.length === 0) {
      onChange?.("")
    }
  }

  const handleBlur = () => {
    if (!displayValue) return
    const day = fromDisplay(displayValue)
    if (!day) {
      setDisplayValue(toDisplay(value))
      return
    }
    setDisplayValue(toDisplay(day))
    onChange?.(day)
  }

  const handleNativeDateChange = (e: React.ChangeEvent<HTMLInputElement>) => onChange?.(toDueDateValue(e.target.value) ?? "")

  return (
    <div className="relative">
      <input
        ref={hiddenInputRef}
        type="date"
        className="pointer-events-none absolute h-0 w-0 opacity-0"
        onChange={handleNativeDateChange}
        disabled={disabled}
      />

      <div className="relative">
        <Input
          {...props}
          type="text"
          value={displayValue}
          onChange={handleDisplayChange}
          onBlur={handleBlur}
          placeholder="DD-MM-YYYY"
          maxLength={10}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : props["aria-describedby"]}
          className={cn("pr-10", className)}
        />
        <button
          type="button"
          onClick={() => hiddenInputRef.current?.showPicker?.()}
          disabled={disabled}
          aria-label="Open date picker"
          className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:opacity-50"
        >
          <Calendar className="h-4 w-4" />
        </button>
      </div>

      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  )
}
