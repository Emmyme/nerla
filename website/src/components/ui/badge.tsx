import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center border border-transparent text-caption font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  {
    variants: {
      tone: {
        neutral: "bg-app-sunk text-foreground",
        pistachio: "bg-app-pistachio-soft text-app-pistachio-ink",
        bubblegum: "bg-app-bubblegum-soft text-app-bubblegum-ink",
        sky: "bg-app-sky-soft text-app-sky-ink",
        lavender: "bg-app-lavender-soft text-app-lavender-ink",
        lemon: "bg-app-lemon-soft text-app-lemon-ink",
        berry:
          "border-border bg-card text-app-berry-text before:mr-1.5 before:size-1.5 before:shrink-0 before:rounded-full before:bg-app-berry before:content-['']",
      },
      shape: {
        pill: "rounded-full px-2.5 py-0.5",
        square: "rounded-sm px-2 py-0.5",
      },
    },
    defaultVariants: { tone: "neutral", shape: "pill" },
  },
)

type BadgeProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>

function Badge({ className, tone, shape, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ tone, shape }), className)} {...props} />
}

export { Badge }
