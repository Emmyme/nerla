import { forwardRef, type TextareaHTMLAttributes } from "react"
import { cn } from "@/lib/utils"

// Text this long always reaches the cap, so it skips the hidden copy and typing stays fast
const LONG_TEXT = 4000

type AutosizeTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "rows"> & {
  value: string
  containerClassName?: string
  /** A max-height class. Past it the text scrolls inside the box. */
  cap?: string
}

// A hidden copy of the text sits in the same grid cell, so the textarea grows with its content
export const AutosizeTextarea = forwardRef<HTMLTextAreaElement, AutosizeTextareaProps>(function AutosizeTextarea(
  { value, className, containerClassName, cap, ...props },
  ref,
) {
  const box = "col-start-1 row-start-1 whitespace-pre-wrap break-words"
  const atCap = !!cap && value.length > LONG_TEXT
  return (
    <div className={cn("grid min-w-0", containerClassName)}>
      {!atCap && (
        <span aria-hidden="true" className={cn(box, "invisible overflow-hidden", className, cap)}>
          {`${value} `}
        </span>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={value}
        className={cn(box, "resize-none", cap ? "overflow-y-auto" : "overflow-hidden", className, cap, atCap && "h-dvh")}
        {...props}
      />
    </div>
  )
})
