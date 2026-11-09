import { useEffect, useState } from "react"
import { ChevronLeft, ChevronRight, Warning } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { CatNapping } from "@/components/ui/cat-scenes"
import { Skeleton } from "@/components/ui/skeleton"
import { timeAPI, type TimeEntry, type TimeSuggestion, type TimeWeek } from "@/lib/api/time"
import { formatDaySpan, parseDueDate } from "@/lib/dates"
import { messageOf } from "@/lib/taskStore"
import { onSocketReconnect } from "@/lib/socket"
import { formatMinutes } from "@/lib/timeFormat"
import { onTimeChanged } from "@/lib/timeStore"
import { EntryRow } from "./EntryRow"
import { LogTimePopover } from "./LogTimePopover"
import { SuggestionRow } from "./SuggestionRow"
import { applyToWeek, dayName, shiftDate } from "./timeView"

const LOAD_FAILED = "Couldn't load the week. Try again."

const ICON_BUTTON =
  "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring max-lg:size-11"

type Loaded =
  | { status: "ready"; week: TimeWeek }
  | { status: "loading"; week: TimeWeek | null }
  | { status: "error"; week: TimeWeek | null; error: string }

const lockedFor = (week: TimeWeek, suggestion: TimeSuggestion) => {
  const until = suggestion.project ? week.lockedUntil[suggestion.project.id] : undefined
  return !!until && suggestion.date <= until
}

function WeekSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <span role="status" className="sr-only">
        Loading the week
      </span>
      {[0, 1, 2].map((day) => (
        <div key={day} aria-hidden="true" className="flex flex-col gap-2">
          <Skeleton className="h-[0.9rem] w-[6rem]" />
          <Skeleton className="h-[2.75rem] w-full rounded-lg" />
        </div>
      ))}
    </div>
  )
}

/** The user's week from a Monday: each day's entries, then its suggestions, with a Log time on every day */
export function WeekReview({ start, today, onWeek }: { start: string; today: string; onWeek: (start: string | null) => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading", week: null })
  const [reload, setReload] = useState(0)
  const end = shiftDate(start, 6)
  const thisWeek = today >= start && today <= end

  useEffect(
    () => onTimeChanged((dates) => dates.some((date) => date >= start && date <= end) && setReload((count) => count + 1)),
    [start, end],
  )
  useEffect(() => onSocketReconnect(() => setReload((count) => count + 1)), [])

  useEffect(() => {
    const controller = new AbortController()
    setLoaded((shown) => (shown.week?.start === start ? shown : { status: "loading", week: null }))
    timeAPI.week(start, controller.signal).then(
      (week) => setLoaded({ status: "ready", week }),
      (err) =>
        !controller.signal.aborted && setLoaded((shown) => ({ status: "error", week: shown.week, error: messageOf(err, LOAD_FAILED) })),
    )
    return () => controller.abort()
  }, [start, reload])

  const change = (applied: Parameters<typeof applyToWeek>[1]) =>
    setLoaded((shown) => (shown.week ? { status: "ready", week: applyToWeek(shown.week, applied) } : shown))
  const saved = (entry: TimeEntry) => change({ entry })
  const deleted = (entry: TimeEntry) => change({ removedId: entry.id })

  const week = loaded.week?.start === start ? loaded.week : null
  const empty = week?.days.every((day) => day.entries.length === 0 && day.suggestions.length === 0)
  const first = parseDueDate(start)
  const last = parseDueDate(end)

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-0.5">
          <Button type="button" variant="outline" disabled={thisWeek} onClick={() => onWeek(null)} className="mr-1.5">
            This week
          </Button>
          <button type="button" aria-label="Previous week" onClick={() => onWeek(shiftDate(start, -7))} className={ICON_BUTTON}>
            <ChevronLeft aria-hidden="true" weight="bold" className="size-[1rem]" />
          </button>
          <button type="button" aria-label="Next week" onClick={() => onWeek(shiftDate(start, 7))} className={ICON_BUTTON}>
            <ChevronRight aria-hidden="true" weight="bold" className="size-[1rem]" />
          </button>
        </div>
        <h2 aria-live="polite" className="min-w-0 text-body font-semibold text-foreground">
          {first && last ? formatDaySpan(first, last) : start}
        </h2>
        <p className="ml-auto text-ui text-muted-foreground">
          Week total <span className="font-semibold text-foreground tabular-nums">{week ? formatMinutes(week.minutes) : "…"}</span>
        </p>
      </div>

      {loaded.status === "error" && (
        <div role="alert" className="flex items-center gap-2.5 rounded-lg border-[0.0625rem] border-border bg-card py-1 pr-1 pl-3 text-ui">
          <Warning aria-hidden="true" weight="fill" className="size-[1rem] shrink-0 text-app-berry" />
          <span className="min-w-0 flex-1 text-app-berry-text">{loaded.error}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setReload((count) => count + 1)}>
            Try again
          </Button>
        </div>
      )}

      {!week ? (
        loaded.status !== "error" && <WeekSkeleton />
      ) : empty ? (
        <div className="flex flex-col items-center gap-3 rounded-xl px-4 py-12 text-center ring-[0.0625rem] ring-border">
          <CatNapping />
          <p className="text-body font-semibold text-foreground">Nothing logged this week</p>
          <LogTimePopover date={thisWeek ? today : start} onLogged={saved} className="bg-app-sunk hover:bg-app-hover" />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {week.days.map((day) => {
            const headingId = `time-day-${day.date}`
            return (
              <section key={day.date} aria-labelledby={headingId} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <h3 id={headingId} className="text-ui font-semibold text-foreground">
                    {dayName(day.date)}
                  </h3>
                  {day.date === today && (
                    <span className="rounded-sm bg-app-pistachio-soft px-1.5 text-caption font-medium text-app-pistachio-ink">Today</span>
                  )}
                  {day.minutes > 0 && (
                    <span className="ml-auto text-ui font-medium text-muted-foreground tabular-nums">{formatMinutes(day.minutes)}</span>
                  )}
                  <LogTimePopover date={day.date} onLogged={saved} className={day.minutes > 0 ? "-mr-1 px-2" : "-mr-1 ml-auto px-2"} />
                </div>
                {day.entries.length > 0 && (
                  <ul
                    aria-label={`Entries on ${dayName(day.date)}`}
                    className="divide-y-[0.0625rem] divide-border overflow-hidden rounded-lg bg-card ring-[0.0625rem] ring-border"
                  >
                    {day.entries.map((entry) => (
                      <EntryRow key={entry.id} entry={entry} onSaved={saved} onDeleted={deleted} />
                    ))}
                  </ul>
                )}
                {day.suggestions.length > 0 && (
                  <ul aria-label={`Suggestions for ${dayName(day.date)}`} className="flex flex-col gap-1">
                    {day.suggestions.map((suggestion) => (
                      <SuggestionRow
                        key={suggestion.key}
                        suggestion={suggestion}
                        locked={lockedFor(week, suggestion)}
                        onAdded={(entry, key) => change({ entry, suggestionKey: key })}
                        onDismissed={(key) => change({ suggestionKey: key })}
                      />
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
