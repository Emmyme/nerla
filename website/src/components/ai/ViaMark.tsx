import { lazy, Suspense } from "react"
import { IconTip } from "@/components/ui/icon-tip"
import { Robot } from "@/components/icons"
import type { Via } from "@/lib/api/ai"
import { useAiTeammate } from "@/lib/aiStore"
import { cn } from "@/lib/utils"
import { AiBadge, AiFace } from "./AiAvatar"
import { viaLabel, type ViaVerb } from "./via"

const AiText = lazy(() => import("./AiText"))

/**
 * The mark on something made for a user: the AI's small cat for the built-in AI, the quiet robot for an outside agent.
 * Its label is its tooltip and its name. `inside` is for a mark within a button or link, where it can't take focus and
 * the label joins the control's name
 */
export function ViaMark({
  via,
  personName,
  verb,
  inside = false,
  className,
}: {
  via: Via
  personName: string
  verb?: ViaVerb
  inside?: boolean
  className?: string
}) {
  const teammate = useAiTeammate()
  const label = viaLabel(via, personName, teammate?.name ?? "Nerla AI", verb)
  const icon = via.kind === "ai" ? <AiFace size={0.875} /> : <Robot aria-hidden="true" className="size-[0.875rem]" />
  if (inside) {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn("inline-flex shrink-0 items-center text-muted-foreground", className)}
      >
        {icon}
      </span>
    )
  }
  return (
    <IconTip label={label}>
      <span
        role="img"
        tabIndex={0}
        aria-label={label}
        className={cn(
          "inline-flex shrink-0 items-center rounded-sm text-muted-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
          className,
        )}
      >
        {icon}
      </span>
    </IconTip>
  )
}

/** The name line of something the AI said itself: its name, the badge, and who asked */
export function AiByline({ asker, className }: { asker: string; className?: string }) {
  const teammate = useAiTeammate()
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <span className="shrink-0 font-semibold text-foreground">{teammate?.name ?? "Nerla AI"}</span>
      <AiBadge />
      <span className="min-w-0 truncate text-caption font-normal text-muted-foreground">Asked by {asker}</span>
    </span>
  )
}

/** What the AI said, formatted once its reader has loaded and plain text until then */
export function AiSaidText({ text, className }: { text: string; className?: string }) {
  return (
    <Suspense fallback={text}>
      <AiText text={text} className={className} />
    </Suspense>
  )
}
