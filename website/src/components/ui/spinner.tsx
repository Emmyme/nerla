import { Spinner as SpinnerIcon } from "@/components/icons"

import { cn } from "@/lib/utils"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return <SpinnerIcon role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
}

type LoadingSpinnerProps = React.ComponentProps<"svg"> & { size?: "md" | "lg" }

/** The blue loader for a page, panel, list or preview. Inside a button use Spinner, which follows the text colour */
function LoadingSpinner({ size = "md", className, ...props }: LoadingSpinnerProps) {
  return (
    <SpinnerIcon
      role="status"
      aria-label="Loading"
      weight="bold"
      className={cn("animate-spin text-app-join", size === "lg" ? "size-8" : "size-5", className)}
      {...props}
    />
  )
}

export { LoadingSpinner, Spinner }
