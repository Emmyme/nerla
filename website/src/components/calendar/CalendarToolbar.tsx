import { CalendarDays, ChevronLeft, ChevronRight, SidebarToggle } from "@/components/icons"
import { BellSlot } from "@/components/notifications/BellSlot"
import { Button } from "@/components/ui/button"
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control"
import type { CalendarView } from "@/lib/dates"
import { cn } from "@/lib/utils"

const ICON_BUTTON =
  "flex size-[2.25rem] items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring max-lg:size-11"

/** Today, previous and next, the range title with its week number, and the view switch */
export function CalendarToolbar({
  title,
  week,
  view,
  views,
  periodName,
  compact,
  sideOpen,
  onToggleSide,
  onCreate,
  onToday,
  onStep,
  onView,
}: {
  title: string
  week: number | null
  view: CalendarView
  views: SegmentedOption<CalendarView>[]
  periodName: string
  compact: boolean
  sideOpen: boolean
  onToggleSide: () => void
  onCreate?: () => void
  onToday: () => void
  onStep: (direction: 1 | -1) => void
  onView: (view: CalendarView) => void
}) {
  const nav = (
    <div className="flex items-center gap-0.5">
      <Button type="button" variant="outline" size="sm" aria-keyshortcuts="t" onClick={onToday} className="mr-1.5">
        Today
      </Button>
      <button type="button" aria-label={`Previous ${periodName}`} aria-keyshortcuts="k" onClick={() => onStep(-1)} className={ICON_BUTTON}>
        <ChevronLeft aria-hidden="true" weight="bold" className="size-[1rem]" />
      </button>
      <button type="button" aria-label={`Next ${periodName}`} aria-keyshortcuts="j" onClick={() => onStep(1)} className={ICON_BUTTON}>
        <ChevronRight aria-hidden="true" weight="bold" className="size-[1rem]" />
      </button>
    </div>
  )

  const heading = (
    <div className="flex min-w-0 items-baseline gap-2.5">
      <h1
        aria-live="polite"
        className={cn("truncate leading-[1.2] font-bold tracking-[-0.025em] text-foreground", compact ? "text-title" : "text-page")}
      >
        {title}
      </h1>
      {week !== null && <span className="shrink-0 text-caption font-medium text-muted-foreground tabular-nums">Week {week}</span>}
    </div>
  )

  const sideButton = (
    <button
      type="button"
      aria-label={compact ? "Open calendars" : sideOpen ? "Hide side panel" : "Show side panel"}
      aria-expanded={compact ? undefined : sideOpen}
      onClick={onToggleSide}
      className={ICON_BUTTON}
    >
      {compact ? (
        <CalendarDays aria-hidden="true" className="size-[1.15rem]" />
      ) : (
        <SidebarToggle aria-hidden="true" className="size-[1.15rem]" />
      )}
    </button>
  )

  const switcher = (
    <SegmentedControl
      label="Calendar view"
      value={view}
      onChange={onView}
      options={views}
      className={compact ? "w-full [&>button]:flex-1 [&>button]:justify-center" : undefined}
    />
  )

  if (compact) {
    return (
      <div className="flex flex-col gap-2.5 pb-3">
        <div className="flex items-center gap-1">
          {sideButton}
          <div className="min-w-0 flex-1 pl-0.5">{heading}</div>
          {nav}
          <BellSlot />
        </div>
        {switcher}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 pb-3.5">
      {sideButton}
      {nav}
      {heading}
      <div className="ml-auto flex items-center gap-2.5">
        {!sideOpen && onCreate && (
          <Button type="button" shortcut="C" onClick={onCreate}>
            Create
          </Button>
        )}
        {switcher}
        <BellSlot />
      </div>
    </div>
  )
}
