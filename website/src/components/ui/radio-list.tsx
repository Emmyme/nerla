import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** `control` is a field that belongs to the choice, such as the date for "Ends on", shown beside the label */
type RadioListOption<T extends string> = { value: T; label: string; description?: string; control?: ReactNode }

/** A stack of choices, one of which is picked. Native radios keep the keyboard and screen reader behaviour. */
export function RadioList<T extends string>({
  name,
  value,
  options,
  onChange,
  className,
}: {
  name: string
  value: T
  options: RadioListOption<T>[]
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div className={cn("@container flex flex-col gap-1.5", className)}>
      {options.map((option) => {
        const checked = value === option.value
        return (
          <div
            key={option.value}
            onClick={(event) => {
              // The row around a field picks the option too, but the field and portalled popovers stay their own
              const target = event.target as Element
              if (event.currentTarget.contains(target) && !target.closest("label, input, button, select, textarea, a"))
                onChange(option.value)
            }}
            className={cn(
              "relative flex items-center rounded-lg ring-[0.0625rem] ring-border transition-colors duration-150 ring-inset hover:bg-app-hover has-[input[type=radio]:focus-visible]:ring-[0.125rem] has-[input[type=radio]:focus-visible]:ring-ring",
              checked && "bg-app-selected ring-app-sky-strong hover:bg-app-selected",
              option.control && "cursor-pointer flex-wrap pr-3.5 @2xs:flex-nowrap @2xs:gap-3",
            )}
          >
            <label
              className={cn(
                "flex cursor-pointer items-start gap-3 py-3 pl-3.5",
                option.control ? "shrink-0 basis-full pb-2 @2xs:min-w-22 @2xs:basis-auto @2xs:pb-3" : "flex-1 pr-3.5",
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-[1rem] shrink-0 items-center justify-center rounded-full ring-inset",
                  checked ? "ring-[0.125rem] ring-foreground" : "ring-[0.0625rem] ring-input",
                )}
              >
                {checked && <span className="size-[0.45rem] rounded-full bg-foreground" />}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body font-medium text-foreground">{option.label}</span>
                {option.description && <span className="text-ui text-muted-foreground">{option.description}</span>}
              </span>
            </label>
            {option.control && (
              <div className="flex min-w-0 items-center gap-2.5 pb-3 pl-10.5 text-body text-foreground @2xs:py-1 @2xs:pl-0">
                {option.control}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
