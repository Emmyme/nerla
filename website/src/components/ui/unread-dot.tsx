import { cn } from "@/lib/utils"

export function UnreadDot({ label, className }: { label?: string; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0", className)}>
      <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-app-unread" />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  )
}
