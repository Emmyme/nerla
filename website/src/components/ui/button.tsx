import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { ShortcutHint } from "./shortcut-hint"

// A fill is blanked in Windows high contrast, so a filled button keeps an edge there
const FORCED_EDGE = "forced-colors:border forced-colors:border-[ButtonText]"

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[color,background-color,border-color,opacity,transform,filter] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress aria-busy:opacity-50 aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: `bg-accent text-[var(--color-text-on-accent)] hover:bg-[var(--color-accent-hover)] active:scale-[0.98] disabled:bg-app-sunk disabled:text-muted-foreground disabled:opacity-100 aria-disabled:bg-app-sunk aria-disabled:text-muted-foreground aria-disabled:opacity-100 aria-disabled:hover:bg-app-sunk aria-disabled:active:scale-100 ${FORCED_EDGE}`,
        destructive: "border border-border bg-card text-app-berry-text hover:border-app-berry hover:bg-app-hover active:scale-[0.98]",
        outline: "border border-border bg-card text-foreground hover:bg-app-hover active:scale-[0.98]",
        secondary: `bg-app-sunk text-foreground hover:bg-app-hover active:scale-[0.98] ${FORCED_EDGE}`,
        ghost: "text-foreground hover:bg-app-hover active:bg-app-sunk",
        sky: `bg-app-sky text-app-sky-ink hover:bg-[color-mix(in_srgb,var(--color-sky)_80%,var(--color-sky-strong))] active:scale-[0.98] disabled:bg-app-sunk disabled:text-muted-foreground disabled:opacity-100 aria-disabled:bg-app-sunk aria-disabled:text-muted-foreground aria-disabled:opacity-100 aria-disabled:hover:bg-app-sunk aria-disabled:active:scale-100 ${FORCED_EDGE}`,
        join: `bg-app-join text-white hover:brightness-90 active:scale-[0.98] ${FORCED_EDGE}`,
        // The chat bubble look: the primary pink with a white icon, as on the docked chat
        bubble: `bg-accent text-white hover:bg-[var(--color-accent-hover)] active:scale-[0.98] ${FORCED_EDGE}`,
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 text-ui max-lg:h-11 max-lg:px-4",
        sm: "h-7 px-2.5 text-caption max-lg:h-11 max-lg:px-4",
        lg: "h-9 px-4 text-body max-lg:h-11",
        icon: "size-8 max-lg:size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

const FILLED = new Set(["default", "sky", "join", "bubble"])

// A text button shows its shortcut or a leading icon, never both
function withoutLeadingIcon(children: React.ReactNode) {
  const items = React.Children.toArray(children)
  const label = items.findIndex((child) => typeof child === "string" || typeof child === "number")
  return label > 0 ? items.slice(label) : children
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /** A key shown after the label, also announced through aria-keyshortcuts */
  shortcut?: string
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, shortcut, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} aria-keyshortcuts={shortcut?.toLowerCase()} {...props}>
        {shortcut && !asChild ? (
          <>
            {withoutLeadingIcon(children)}
            <ShortcutHint keys={shortcut} variant={FILLED.has(variant ?? "default") ? "solid" : "outline"} />
          </>
        ) : (
          children
        )}
      </Comp>
    )
  },
)
Button.displayName = "Button"

export { Button }
