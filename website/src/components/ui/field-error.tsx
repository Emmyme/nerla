import * as React from "react"

import { cn } from "@/lib/utils"

const FieldError = React.forwardRef<HTMLParagraphElement, React.ComponentProps<"p">>(({ className, ...props }, ref) => (
  // Announced as it appears, since a failed submit leaves focus where it was
  <p ref={ref} role="alert" className={cn("mt-1 text-caption text-app-berry-text", className)} {...props} />
))
FieldError.displayName = "FieldError"

export { FieldError }
