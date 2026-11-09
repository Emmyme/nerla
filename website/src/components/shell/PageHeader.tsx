import type { ReactNode, Ref } from "react"
import { BellSlot } from "@/components/notifications/BellSlot"

// The title row is as tall as the primary button, so titles and buttons sit at the same place on every page.
// The actions never wrap below the title, so on a narrow screen the title shortens instead
export function PageHeader({
  title,
  meta,
  actions,
  titleRef,
  bell = true,
}: {
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  titleRef?: Ref<HTMLHeadingElement>
  /** The notification bell's place at the end of the actions. A page whose top right is elsewhere turns it off */
  bell?: boolean
}) {
  return (
    <header className="flex items-start justify-between gap-x-4 max-lg:gap-x-3">
      <div className="min-w-0 flex-1">
        <h1
          ref={titleRef}
          tabIndex={titleRef ? -1 : undefined}
          className="flex min-h-10 min-w-0 items-center gap-2.5 rounded-sm text-page leading-[1.1] font-bold tracking-[-0.025em] text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11"
        >
          {typeof title === "string" ? <span className="min-w-0 truncate">{title}</span> : title}
        </h1>
        {meta && <div className="mt-1 text-body text-muted-foreground">{meta}</div>}
      </div>
      {(actions || bell) && (
        <div className="flex shrink-0 items-center gap-2 self-start">
          {actions}
          {bell && <BellSlot />}
        </div>
      )}
    </header>
  )
}
