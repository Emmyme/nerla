import { cn } from "@/lib/utils"
import { formatFileSize } from "./fileKinds"
import type { Usage } from "./useFiles"

/** "2.1 GB of 10 GB" with a bar, or "2.1 GB used" when there is no cap */
export function UsageMeter({ usage, className }: { usage: Usage | null; className?: string }) {
  if (!usage) return <div aria-hidden="true" className={cn("h-[2.25rem]", className)} />
  const { used, cap } = usage
  const share = cap ? Math.min(1, used / cap) : 0
  const label = cap ? `${formatFileSize(used)} of ${formatFileSize(cap)}` : `${formatFileSize(used)} used`
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {cap !== null && (
        <span
          role="meter"
          aria-label="Storage used"
          aria-valuemin={0}
          aria-valuemax={cap}
          aria-valuenow={Math.min(used, cap)}
          aria-valuetext={label}
          className="h-[0.375rem] overflow-hidden rounded-full bg-app-sunk"
        >
          <span
            className={cn("block h-full rounded-full", share >= 0.9 ? "bg-app-berry" : "bg-app-pistachio-strong")}
            style={{ width: `${Math.max(share * 100, used > 0 ? 2 : 0)}%` }}
          />
        </span>
      )}
      <span className="text-caption font-medium text-muted-foreground tabular-nums">{label}</span>
    </div>
  )
}
