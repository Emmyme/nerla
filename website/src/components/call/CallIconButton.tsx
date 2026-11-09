import { forwardRef, type ButtonHTMLAttributes } from "react"
import { Slot } from "@radix-ui/react-slot"
import { useMediaQuery } from "@/lib/useMediaQuery"
import { ShortcutHint } from "@/components/ui/shortcut-hint"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type CallTone = "idle" | "active" | "off"

const TONE: Record<CallTone, string> = {
  idle: "bg-app-sunk text-app-text hover:bg-app-border",
  active: "bg-app-sky text-app-sky-ink hover:bg-app-sky/90",
  off: "bg-app-berry text-app-bg hover:bg-app-berry/90",
}

export const CALL_FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg"

/** Touch screens have no hover, so a tooltip would only flash up on a tap */
export function useNoHover() {
  return useMediaQuery("(hover: none)", false)
}

/** The one input style on the stage: a hairline that turns ink on focus, without the offset ring of the light screens */
export const CALL_FIELD =
  "rounded-md border border-app-border bg-transparent text-ui text-app-text transition-colors duration-150 placeholder:text-app-text-muted focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  /** Tooltip text when it should say more than the label, such as "Turn off microphone" */
  tip?: string
  tone?: CallTone
  pressed?: boolean
  shortcut?: string
  side?: "top" | "bottom" | "left" | "right"
  asChild?: boolean
}

/** A round 2.75rem stage button with a tooltip that names it, plus its shortcut when it has one. Touch screens go without the tooltip */
export const CallIconButton = forwardRef<HTMLButtonElement, Props>(function CallIconButton(
  { label, tip, tone = "idle", pressed, shortcut, side = "top", asChild, className, children, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button"
  const touch = useNoHover()
  const button = (
    <Comp
      ref={ref}
      type={asChild ? undefined : "button"}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        "inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-5 [&_svg]:shrink-0",
        CALL_FOCUS,
        TONE[tone],
        className,
      )}
      {...props}
    >
      {children}
    </Comp>
  )
  if (touch) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={side} className="flex items-center gap-2">
        {tip ?? label}
        {shortcut && <ShortcutHint keys={shortcut} variant="outline" className="border-background/30 text-background/75" />}
      </TooltipContent>
    </Tooltip>
  )
})
