import { markedVia } from "@/components/ai/via"
import { ViaMark } from "@/components/ai/ViaMark"
import { Lock, User } from "@/components/icons"
import { IdentityTile } from "@/components/ui/identity-tile"
import type { TimeEntry, TimeProjectRef, TimeTaskRef } from "@/lib/api/time"
import { formatMinutes } from "@/lib/timeFormat"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"
import { LogTimePopover } from "./LogTimePopover"
import { taskLabel } from "./PlacePicker"

// The badge look as spans, since a row can be a button
const AUTO = "inline-flex items-center rounded-sm bg-app-sky-soft px-2 py-0.5 text-caption font-medium text-app-sky-ink"
const CHECK =
  "inline-flex items-center rounded-full border border-border bg-card px-2.5 py-0.5 text-caption font-medium text-app-berry-text before:mr-1.5 before:size-1.5 before:shrink-0 before:rounded-full before:bg-app-berry before:content-['']"

const ROW = "flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left max-lg:py-2.5"

type Placed = { project: TimeProjectRef | null; task: TimeTaskRef | null; deletedProjectName?: string | null; taskLabel?: string | null }

/** What the time is on, and the line under it */
export function placeLines(placed: Placed): { title: string; under: string | null } {
  const projectName = placed.project?.name ?? (placed.deletedProjectName ? `Deleted project: ${placed.deletedProjectName}` : null)
  if (placed.task) return { title: taskLabel(placed.task), under: projectName ?? "Personal task" }
  if (placed.taskLabel) return { title: `Deleted task: ${placed.taskLabel}`, under: projectName }
  return { title: projectName ?? "Personal task", under: null }
}

export function PlaceGlyph({ project, personal }: { project: TimeProjectRef | null; personal: boolean }) {
  if (personal) return <User aria-hidden="true" weight="fill" className="size-[1.0625rem] shrink-0 p-0.5 text-app-lavender-strong" />
  return <IdentityTile color={project?.color} symbol={null} size="sm" className={project ? undefined : "opacity-40"} />
}

function Badges({ entry, className }: { entry: TimeEntry; className: string }) {
  if (!entry.auto && !entry.needsCheck) return null
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", className)}>
      {entry.auto && <span className={AUTO}>Auto</span>}
      {entry.needsCheck && <span className={CHECK}>Check this entry</span>}
    </span>
  )
}

function Body({ entry, me, inside }: { entry: TimeEntry; me: string; inside: boolean }) {
  const { title, under } = placeLines(entry)
  const sub = [under, entry.note].filter(Boolean).join(" · ")
  return (
    <>
      <PlaceGlyph project={entry.project} personal={!entry.project && !!entry.task} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-ui font-medium text-foreground">{title}</span>
          {markedVia(entry.done_via) && <ViaMark via={entry.done_via} personName={me} inside={inside} />}
        </span>
        {sub && <span className="truncate text-caption text-muted-foreground">{sub}</span>}
        <Badges entry={entry} className="mt-1 sm:hidden" />
      </span>
      <Badges entry={entry} className="max-sm:hidden" />
      <span className="shrink-0 text-ui font-medium text-foreground tabular-nums">{formatMinutes(entry.minutes)}</span>
    </>
  )
}

/** One of the user's entries. It opens to change, unless its day is locked */
export function EntryRow({
  entry,
  onSaved,
  onDeleted,
}: {
  entry: TimeEntry
  onSaved: (entry: TimeEntry) => void
  onDeleted: (entry: TimeEntry) => void
}) {
  const { user } = useAuth()
  const me = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "You"
  if (entry.locked) {
    return (
      <li className={ROW}>
        <Body entry={entry} me={me} inside={false} />
        <span title="Locked" className="flex size-[1.25rem] shrink-0 items-center justify-center text-muted-foreground">
          <Lock aria-hidden="true" className="size-[0.95rem]" />
          <span className="sr-only">Locked</span>
        </span>
      </li>
    )
  }
  return (
    <li>
      <LogTimePopover entry={entry} onLogged={onSaved} onDeleted={onDeleted}>
        <button
          type="button"
          className={cn(
            ROW,
            "cursor-pointer transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
          )}
        >
          <Body entry={entry} me={me} inside />
          <span aria-hidden="true" className="size-[1.25rem] shrink-0" />
        </button>
      </LogTimePopover>
    </li>
  )
}
