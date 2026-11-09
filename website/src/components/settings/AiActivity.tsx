import { Skeleton } from "@/components/ui/skeleton"
import { aiAPI, type AiActivityResult, type AiActivityRow } from "@/lib/api/ai"
import { formatRelative, formatShortDate, formatTime, parseServerDate } from "@/lib/dates"
import { useBusyLoad } from "@/lib/useBusyRetry"
import { cn } from "@/lib/utils"
import { LoadError, LoadingRows } from "./LoadState"

const LOAD_FAILED = "Couldn't load the activity. Check your connection and try again."

const TARGETS: Record<string, string> = {
  task: "Task",
  project: "Project",
  doc: "Paper or board",
  file: "File",
  chat: "Chat",
  event: "Event",
  person: "Person",
}

const RESULTS: Record<AiActivityResult, { label: string; tone: string }> = {
  ok: { label: "Done", tone: "bg-app-pistachio-soft text-app-pistachio-ink" },
  held: { label: "Waited for Allow", tone: "bg-app-lemon-soft text-app-lemon-ink" },
  denied: { label: "Denied", tone: "bg-app-sunk text-foreground" },
  refused: { label: "Refused", tone: "bg-app-sunk text-foreground" },
  failed: { label: "Failed", tone: "bg-app-sunk text-app-berry-text" },
}

const toolName = (tool: string) => (tool === "unknown" ? "Unknown tool" : tool[0].toUpperCase() + tool.slice(1).replace(/_/g, " "))
const exactTime = (value: string) => {
  const date = parseServerDate(value)
  return date ? `${formatShortDate(date)} ${formatTime(date)}` : value
}

/** Who did what through the AI or an agent, newest first. Never any content */
export function AiActivity({ scope, aiName }: { scope: "mine" | "workspace"; aiName: string }) {
  const { data: rows, loadError, busy, retry } = useBusyLoad(() => aiAPI.activity(scope), LOAD_FAILED, scope)
  const everyone = scope === "workspace"
  const columns = everyone
    ? "sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_8.5rem]"
    : "sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_8.5rem]"

  if (loadError) return <LoadError message={loadError} onRetry={retry} />
  if (!rows)
    return (
      <LoadingRows label="Loading the activity" busy={busy}>
        <Skeleton className="h-[2.75rem] rounded-lg" />
        <Skeleton className="h-[2.75rem] rounded-lg" />
      </LoadingRows>
    )
  if (rows.length === 0) return <p className="text-body text-muted-foreground">Nothing yet.</p>

  const through = (row: AiActivityRow) => (row.source === "mcp" ? (row.tokenName ?? "An agent") : aiName)

  // A table for screen readers on every width. Phones show two cells a row, the tool with the rest under it and the result
  return (
    <div role="table" aria-label="Activity" className="overflow-hidden rounded-lg bg-card ring-[0.0625rem] ring-border">
      <div role="rowgroup" className="max-sm:hidden">
        <div
          role="row"
          className={cn(
            "grid items-center gap-x-3 border-b-[0.0625rem] border-border px-3 py-2 text-caption font-medium text-muted-foreground",
            columns,
          )}
        >
          <span role="columnheader">When</span>
          {everyone && <span role="columnheader">Who</span>}
          <span role="columnheader">Through</span>
          <span role="columnheader">Tool</span>
          <span role="columnheader">Target</span>
          <span role="columnheader">Result</span>
        </div>
      </div>
      <div role="rowgroup" className="divide-y-[0.0625rem] divide-border">
        {rows.map((row) => {
          const result = RESULTS[row.result] ?? RESULTS.failed
          const target = row.targetKind ? (TARGETS[row.targetKind] ?? row.targetKind) : "None"
          return (
            <div
              key={row.id}
              role="row"
              className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2", columns)}
            >
              <span role="cell" className="text-ui text-muted-foreground tabular-nums max-sm:hidden">
                <time dateTime={row.createdAt} title={exactTime(row.createdAt)}>
                  {formatRelative(row.createdAt)}
                </time>
              </span>
              {everyone && (
                <span role="cell" className="truncate text-ui text-foreground max-sm:hidden">
                  {row.userName}
                </span>
              )}
              <span role="cell" className="truncate text-ui text-foreground max-sm:hidden">
                {through(row)}
              </span>
              <span role="cell" className="flex min-w-0 flex-col">
                <span className="truncate text-ui font-medium text-foreground">{toolName(row.tool)}</span>
                <span className="truncate text-caption text-muted-foreground sm:hidden">
                  {[formatRelative(row.createdAt), everyone ? row.userName : null, through(row), row.targetKind ? target : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span role="cell" className="truncate text-ui text-muted-foreground max-sm:hidden">
                {target}
              </span>
              <span role="cell" className="justify-self-end sm:justify-self-start">
                <span className={cn("inline-block rounded-full px-2 py-0.5 text-caption font-medium", result.tone)}>{result.label}</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
