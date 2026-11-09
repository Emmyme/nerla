import { useState } from "react"
import { toast } from "sonner"
import { Lock, X } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { timeAPI, type TimeEntry, type TimeEntryCreate, type TimeSuggestion } from "@/lib/api/time"
import { messageOf } from "@/lib/taskStore"
import { formatMinutes } from "@/lib/timeFormat"
import { useProjects } from "@/lib/useProjects"
import { PlaceGlyph } from "./EntryRow"

const STEP = 15
const DAY = 1440
const KINDS = { meeting: "Meeting", task: "Task you worked on", repeat: "Same as last week" } as const
const ADD_FAILED = "Couldn't add it. Try again."
const DISMISS_FAILED = "Couldn't dismiss it. Try again."

/** What accepting sends: the suggestion's own place, or the project picked for a meeting */
function entryOf(suggestion: TimeSuggestion, minutes: number, projectId: string | null): TimeEntryCreate {
  const base = { date: suggestion.date, minutes, source: "suggestion" as const, suggestionKey: suggestion.key }
  if (suggestion.kind === "meeting") return { ...base, projectId: projectId ?? suggestion.project?.id, note: suggestion.title || null }
  const ownNote = suggestion.title && suggestion.title !== suggestion.task?.title && suggestion.title !== suggestion.project?.name
  const place = suggestion.task ? { taskId: suggestion.task.id } : { projectId: suggestion.project?.id }
  return { ...base, ...place, note: suggestion.kind === "repeat" && ownNote ? suggestion.title : null }
}

/** A suggested entry: shorter or longer by 15 minutes, then Add, or Dismiss for good */
export function SuggestionRow({
  suggestion,
  locked,
  onAdded,
  onDismissed,
}: {
  suggestion: TimeSuggestion
  locked: boolean
  onAdded: (entry: TimeEntry, key: string) => void
  onDismissed: (key: string) => void
}) {
  const { projects } = useProjects()
  const [minutes, setMinutes] = useState(suggestion.minutes)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const askProject = suggestion.needsProject
  const memberProjects = projects.filter((project) => project.member !== false && project.status !== "archived")
  const title = suggestion.task?.identifier ? `${suggestion.task.identifier} ${suggestion.title}` : suggestion.title
  const under = [KINDS[suggestion.kind], suggestion.project?.name ?? (suggestion.task ? "Personal task" : null)].filter(Boolean).join(" · ")

  const add = async () => {
    if (busy) return
    if (askProject && !projectId) {
      setPicking(true)
      return
    }
    setBusy(true)
    try {
      const { entry } = await timeAPI.createEntry(entryOf(suggestion, minutes, projectId))
      toast.success(`Logged ${formatMinutes(entry.minutes)}`)
      onAdded(entry, suggestion.key)
    } catch (err) {
      toast.error(messageOf(err, ADD_FAILED))
      setBusy(false)
    }
  }

  const dismiss = async () => {
    if (busy) return
    setBusy(true)
    try {
      await timeAPI.dismiss(suggestion.key)
      onDismissed(suggestion.key)
    } catch (err) {
      toast.error(messageOf(err, DISMISS_FAILED))
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-app-selected py-1.5 pr-1.5 pl-3 max-lg:py-2">
      <span className="flex min-w-0 flex-1 basis-[12rem] items-center gap-3">
        <PlaceGlyph project={suggestion.project} personal={!suggestion.project && !!suggestion.task} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-ui font-medium text-foreground">{title || KINDS[suggestion.kind]}</span>
          <span className="truncate text-caption text-muted-foreground">{under}</span>
        </span>
      </span>
      {askProject && !locked && (
        <Select value={projectId ?? undefined} onValueChange={setProjectId} open={picking} onOpenChange={setPicking}>
          <SelectTrigger
            aria-label={`Project for ${suggestion.title || "this meeting"}`}
            className="w-[11rem] border-transparent bg-card font-medium max-sm:flex-1"
          >
            <SelectValue placeholder="Pick a project" />
          </SelectTrigger>
          <SelectContent>
            {memberProjects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {!locked && (
          <span role="group" aria-label="Length" className="flex items-center">
            <Button type="button" variant="ghost" disabled={minutes <= STEP} onClick={() => setMinutes((m) => m - STEP)} className="px-2">
              −15m
            </Button>
            <span aria-live="polite" className="min-w-[3.75rem] text-center text-ui font-medium text-foreground tabular-nums">
              {formatMinutes(minutes)}
            </span>
            <Button
              type="button"
              variant="ghost"
              disabled={minutes + STEP > DAY}
              onClick={() => setMinutes((m) => m + STEP)}
              className="px-2"
            >
              +15m
            </Button>
          </span>
        )}
        {locked ? (
          <span title="Locked" className="flex h-8 items-center gap-1.5 px-2 text-ui text-muted-foreground max-lg:h-11">
            <Lock aria-hidden="true" className="size-[0.95rem]" />
            {formatMinutes(minutes)}
            <span className="sr-only">, locked</span>
          </span>
        ) : (
          <Button type="button" variant="outline" aria-busy={busy || undefined} onClick={() => void add()}>
            Add
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Dismiss"
          title="Dismiss"
          disabled={busy}
          onClick={() => void dismiss()}
        >
          <X aria-hidden="true" className="size-[1rem]" />
        </Button>
      </span>
    </li>
  )
}
