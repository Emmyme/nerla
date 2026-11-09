import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { useSearchParams } from "react-router"
import { toast } from "sonner"
import { ChevronDown, Download, Lock, Sort, Warning } from "@/components/icons"
import { BottomSheet } from "@/components/ui/bottom-sheet"
import { CheckItem, MENU_ITEM, useMenuKeys } from "@/components/ui/check-menu"
import { Button } from "@/components/ui/button"
import { DateInput } from "@/components/ui/DateInput"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { timeAPI, type TimeGroupBy, type TimeLock, type TimeReport, type TimeReportFilters } from "@/lib/api/time"
import { messageOf } from "@/lib/taskStore"
import { formatMinutes } from "@/lib/timeFormat"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { cn } from "@/lib/utils"
import { placeLines, PlaceGlyph } from "./EntryRow"
import { LocksDialog, LockOfferDialog } from "./TimeLocks"
import { calendarDay, dayName, presetRange, shiftDate, type RangePreset } from "./timeView"

const PRESETS: { value: RangePreset; label: string }[] = [
  { value: "this-week", label: "This week" },
  { value: "last-week", label: "Last week" },
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "custom", label: "Custom" },
]
const GROUPS: { value: TimeGroupBy; label: string }[] = [
  { value: "project", label: "By project" },
  { value: "person", label: "By person" },
  { value: "task", label: "By task" },
]
const LOAD_FAILED = "Couldn't load the report. Try again."
const EXPORT_FAILED = "Couldn't export the CSV. Try again."
const PILL = "w-auto gap-2 border-transparent bg-app-sunk font-medium"
const ENTRY_COLUMNS = "sm:grid-cols-[6.5rem_minmax(7rem,12rem)_minmax(0,1fr)_minmax(0,14rem)_4.5rem]"

type Filters = TimeReportFilters & { preset: RangePreset; people: string[]; projects: string[]; groupBy: TimeGroupBy }
type Option = { id: string; label: string }

const list = (value: string | null) => (value ? value.split(",").filter(Boolean) : [])

function readFilters(params: URLSearchParams, today: string): Filters {
  const preset = PRESETS.find((option) => option.value === params.get("range"))?.value ?? "this-week"
  const groupBy = GROUPS.find((option) => option.value === params.get("group"))?.value ?? "project"
  const from = calendarDay(params.get("from"))
  const to = calendarDay(params.get("to"))
  const range = preset === "custom" ? (from && to ? { from, to } : presetRange("this-week", today)) : presetRange(preset, today)
  return { preset, ...range, people: list(params.get("people")), projects: list(params.get("projects")), groupBy }
}

const toggled = (picked: string[], id: string) => (picked.includes(id) ? picked.filter((one) => one !== id) : [...picked, id])

/** A pill that opens a list to pick several from, as the project page's Filter does */
function CheckMenu({
  label,
  options,
  picked,
  onChange,
}: {
  label: string
  options: Option[]
  picked: string[]
  onChange: (picked: string[]) => void
}) {
  const { open, setOpen, button, menu, onKeyDown: keys } = useMenuKeys()
  const ids = useId()

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${ids}-menu` : undefined}
        aria-label={picked.length ? `${label}, ${picked.length} picked` : undefined}
        onClick={() => setOpen((shown) => !shown)}
        className="inline-flex h-8 items-center gap-2 rounded-md bg-app-sunk px-3 text-ui font-medium text-foreground transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
      >
        {picked.length ? `${label} · ${picked.length}` : `All ${label.toLowerCase()}`}
        <ChevronDown aria-hidden="true" className="size-3.5 opacity-50" />
      </button>
      {open && (
        <div
          ref={menu}
          id={`${ids}-menu`}
          role="menu"
          aria-label={label}
          onKeyDown={keys}
          className="absolute top-full left-0 z-20 mt-1 flex max-h-[min(28rem,70vh)] w-[16rem] flex-col overflow-y-auto rounded-lg border-[0.0625rem] border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-popover)] duration-150 animate-in fade-in-0 zoom-in-95"
        >
          {options.length === 0 && <p className="px-2.5 py-1.5 text-ui text-muted-foreground">Nothing to pick</p>}
          {options.map((option) => (
            <CheckItem
              key={option.id}
              checked={picked.includes(option.id)}
              onToggle={() => onChange(toggled(picked, option.id))}
              label={option.label}
            />
          ))}
          {picked.length > 0 && (
            <>
              <div role="separator" className="mx-1.5 my-1 h-[0.0625rem] shrink-0 bg-border" />
              <button type="button" role="menuitem" tabIndex={-1} onClick={() => onChange([])} className={MENU_ITEM}>
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function PickSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger aria-label={label} className={cn(PILL, className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SheetField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden="true" className="text-ui font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <span role="status" className="sr-only">
        Loading the report
      </span>
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} aria-hidden="true" className="h-[2.25rem] w-full rounded-lg" />
      ))}
    </div>
  )
}

/** Hours across the projects the caller reports on: totals per group, then the entries, with the CSV and locks */
export function TimeReports({ today, workspaceAdmin }: { today: string; workspaceAdmin: boolean }) {
  const desktop = useIsDesktop()
  const [params, setParams] = useSearchParams()
  const filters = readFilters(params, today)
  const key = JSON.stringify([filters.from, filters.to, filters.people, filters.projects, filters.groupBy])
  const [loaded, setLoaded] = useState<{ key: string; report: TimeReport } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [offer, setOffer] = useState<{ until: string; projects: TimeLock[] } | null>(null)
  const [locksOpen, setLocksOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const filtersButton = useRef<HTMLButtonElement>(null)
  const ids = useId()

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    const [from, to, people, projects, groupBy] = JSON.parse(key) as [string, string, string[], string[], TimeGroupBy]
    timeAPI.report({ from, to, people, projects, groupBy }, controller.signal).then(
      (report) => setLoaded({ key, report }),
      (err) => !controller.signal.aborted && setError(messageOf(err, LOAD_FAILED)),
    )
    return () => controller.abort()
  }, [key, attempt])

  const report = loaded?.key === key ? loaded.report : null
  const shownReport = report ?? loaded?.report ?? null

  const update = (changes: Partial<Filters>) =>
    setParams(
      (current) => {
        const next = { ...filters, ...changes }
        const query = new URLSearchParams()
        if (next.preset !== "this-week") query.set("range", next.preset)
        if (next.preset === "custom") {
          query.set("from", next.from)
          query.set("to", next.to)
        }
        if (next.people.length) query.set("people", next.people.join(","))
        if (next.projects.length) query.set("projects", next.projects.join(","))
        if (next.groupBy !== "project") query.set("group", next.groupBy)
        for (const [name, value] of current)
          if (!["range", "from", "to", "people", "projects", "group"].includes(name)) query.set(name, value)
        return query
      },
      { replace: true },
    )

  const pickPreset = (preset: RangePreset) => update(preset === "custom" ? { preset, from: filters.from, to: filters.to } : { preset })

  const exportCsv = async () => {
    if (!report || exporting) return
    setExporting(true)
    try {
      await timeAPI.downloadReportCsv(filters)
      // Never today or later, and a project already locked through that day stays as it is, since an earlier date would unlock
      const yesterday = shiftDate(today, -1)
      const until = filters.to < yesterday ? filters.to : yesterday
      const projects = until < filters.from ? [] : report.lockable.filter((lock) => !lock.lockedUntil || lock.lockedUntil < until)
      if (projects.length) setOffer({ until, projects })
    } catch (err) {
      toast.error(messageOf(err, EXPORT_FAILED))
    } finally {
      setExporting(false)
    }
  }

  const lockedNow = (locks: TimeLock[]) => {
    const by = new Map(locks.map((lock) => [lock.projectId, lock.lockedUntil]))
    setLoaded(
      (shown) =>
        shown && {
          ...shown,
          report: {
            ...shown.report,
            lockable: shown.report.lockable.map((lock) =>
              by.has(lock.projectId) ? { ...lock, lockedUntil: by.get(lock.projectId) ?? null } : lock,
            ),
          },
        },
    )
  }

  const people: Option[] = (shownReport?.options.people ?? []).map((person) => ({ id: person.id, label: person.name }))
  const projects: Option[] = (shownReport?.options.projects ?? []).map((project) => ({ id: project.id, label: project.name }))
  const filterCount =
    filters.people.length + filters.projects.length + (filters.preset !== "this-week" ? 1 : 0) + (filters.groupBy !== "project" ? 1 : 0)

  const dates = filters.preset === "custom" && (
    <>
      <DateInput
        aria-label="From"
        value={filters.from}
        onChange={(from) => calendarDay(from) && update({ from })}
        className="h-8 w-[9.5rem] text-ui max-lg:h-11 max-lg:w-full"
      />
      <DateInput
        aria-label="To"
        value={filters.to}
        onChange={(to) => calendarDay(to) && update({ to })}
        className="h-8 w-[9.5rem] text-ui max-lg:h-11 max-lg:w-full"
      />
    </>
  )

  const actions = (
    <div className="ml-auto flex items-center gap-2">
      <Button type="button" variant="ghost" onClick={() => setLocksOpen(true)}>
        <Lock aria-hidden="true" className="size-[0.95rem]" />
        Locks
      </Button>
      <Button
        type="button"
        variant="outline"
        aria-disabled={!report || undefined}
        aria-busy={exporting || undefined}
        onClick={() => void exportCsv()}
      >
        <Download aria-hidden="true" className="size-[0.95rem]" />
        {exporting ? "Exporting" : "Export CSV"}
      </Button>
    </div>
  )

  const total = shownReport?.minutes ?? 0

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {desktop ? (
          <>
            <PickSelect label="Range" value={filters.preset} options={PRESETS} onChange={pickPreset} />
            {dates}
            <CheckMenu label="People" options={people} picked={filters.people} onChange={(next) => update({ people: next })} />
            <CheckMenu label="Projects" options={projects} picked={filters.projects} onChange={(next) => update({ projects: next })} />
            <PickSelect label="Group" value={filters.groupBy} options={GROUPS} onChange={(groupBy) => update({ groupBy })} />
          </>
        ) : (
          <Button
            ref={filtersButton}
            type="button"
            variant="secondary"
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen(true)}
          >
            <Sort aria-hidden="true" className="size-[1rem]" />
            Filters
            {filterCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-app-pistachio px-1.5 text-micro font-semibold text-app-pistachio-ink tabular-nums">
                <span className="sr-only">, </span>
                {filterCount}
                <span className="sr-only"> on</span>
              </span>
            )}
          </Button>
        )}
        {actions}
      </div>

      {!desktop && (
        <BottomSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          title="Filters"
          showTitle
          returnFocus={() => filtersButton.current?.focus()}
        >
          <div className="flex flex-col gap-3 px-2 pb-2">
            <SheetField label="Range">
              <PickSelect label="Range" value={filters.preset} options={PRESETS} onChange={pickPreset} className="w-full" />
              {dates && <div className="grid grid-cols-2 gap-2">{dates}</div>}
            </SheetField>
            <SheetField label="Group">
              <PickSelect
                label="Group"
                value={filters.groupBy}
                options={GROUPS}
                onChange={(groupBy) => update({ groupBy })}
                className="w-full"
              />
            </SheetField>
            {[
              { label: "People", options: people, picked: filters.people, set: (next: string[]) => update({ people: next }) },
              { label: "Projects", options: projects, picked: filters.projects, set: (next: string[]) => update({ projects: next }) },
            ].map((field) => (
              <div key={field.label} role="group" aria-labelledby={`${ids}-${field.label}`} className="flex flex-col">
                <span id={`${ids}-${field.label}`} className="pb-1 text-ui font-medium text-muted-foreground">
                  {field.label}
                </span>
                {field.options.map((option) => (
                  <CheckItem
                    key={option.id}
                    menu={false}
                    checked={field.picked.includes(option.id)}
                    onToggle={() => field.set(toggled(field.picked, option.id))}
                    label={option.label}
                  />
                ))}
              </div>
            ))}
            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                disabled={filterCount === 0}
                onClick={() => update({ preset: "this-week", people: [], projects: [], groupBy: "project" })}
              >
                Clear filters
              </Button>
              <Button type="button" className="flex-1" onClick={() => setSheetOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        </BottomSheet>
      )}

      {error && (
        <div role="alert" className="flex items-center gap-2.5 rounded-lg border-[0.0625rem] border-border bg-card py-1 pr-1 pl-3 text-ui">
          <Warning aria-hidden="true" weight="fill" className="size-[1rem] shrink-0 text-app-berry" />
          <span className="min-w-0 flex-1 text-app-berry-text">{error}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </Button>
        </div>
      )}

      {!shownReport ? (
        !error && <ReportSkeleton />
      ) : (
        <div
          aria-busy={!report || undefined}
          className={cn("flex flex-col gap-6 transition-opacity duration-150", !report && "opacity-60")}
        >
          <section aria-labelledby={`${ids}-totals`} className="flex flex-col gap-2">
            <div className="flex items-baseline gap-3">
              <h2 id={`${ids}-totals`} className="text-ui font-semibold text-foreground">
                {dayName(filters.from)} to {dayName(filters.to)}
              </h2>
              <p className="ml-auto text-ui text-muted-foreground">
                Total <span className="font-semibold text-foreground tabular-nums">{formatMinutes(total)}</span>
              </p>
            </div>
            {shownReport.groups.length === 0 ? (
              <p className="rounded-xl px-4 py-10 text-center text-body text-muted-foreground ring-[0.0625rem] ring-border">
                No time logged in this range
              </p>
            ) : (
              <ul className="divide-y-[0.0625rem] divide-border overflow-hidden rounded-lg bg-card ring-[0.0625rem] ring-border">
                {shownReport.groups.map((group) => (
                  <li
                    key={group.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(6rem,14rem)_4.5rem]"
                  >
                    <span className="truncate text-ui font-medium text-foreground">{group.label}</span>
                    <span
                      aria-hidden="true"
                      className="h-1.5 overflow-hidden rounded-full bg-app-sunk max-sm:col-span-2 max-sm:row-start-2"
                    >
                      <span
                        className="block h-full rounded-full bg-app-sky-strong"
                        style={{ width: `${total ? Math.max(2, (group.minutes / total) * 100) : 0}%` }}
                      />
                    </span>
                    <span className="text-right text-ui font-medium text-foreground tabular-nums max-sm:col-start-2 max-sm:row-start-1">
                      {formatMinutes(group.minutes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {shownReport.entries.length > 0 && (
            <section aria-labelledby={`${ids}-entries`} className="flex flex-col gap-2">
              <h2 id={`${ids}-entries`} className="text-ui font-semibold text-foreground">
                Entries
              </h2>
              {shownReport.truncated && (
                <p className="rounded-lg bg-app-sunk px-3 py-2 text-ui text-muted-foreground">
                  Showing the first {shownReport.entries.length.toLocaleString("en-GB")} entries. The totals and the CSV include all of
                  them.
                </p>
              )}
              <div className="overflow-hidden rounded-lg bg-card ring-[0.0625rem] ring-border">
                <div
                  aria-hidden="true"
                  className={cn(
                    "grid items-center gap-x-3 border-b-[0.0625rem] border-border px-3 py-2 text-caption font-medium text-muted-foreground max-sm:hidden",
                    ENTRY_COLUMNS,
                  )}
                >
                  <span>Date</span>
                  <span>Person</span>
                  <span>Project and task</span>
                  <span>Note</span>
                  <span className="text-right">Time</span>
                </div>
                <ul aria-label="Entries" className="divide-y-[0.0625rem] divide-border">
                  {shownReport.entries.map((entry) => {
                    const { title, under } = placeLines(entry)
                    const place = under ? `${title} · ${under}` : title
                    return (
                      <li
                        key={entry.id}
                        className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2", ENTRY_COLUMNS)}
                      >
                        <span className="text-ui text-muted-foreground tabular-nums max-sm:hidden">{dayName(entry.date)}</span>
                        <span className="truncate text-ui text-foreground max-sm:hidden">{entry.person.name}</span>
                        <span className="flex min-w-0 items-center gap-2">
                          <PlaceGlyph project={entry.project} personal={false} />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-ui font-medium text-foreground">{place}</span>
                            <span className="truncate text-caption text-muted-foreground sm:hidden">
                              {[dayName(entry.date), entry.person.name, entry.note].filter(Boolean).join(" · ")}
                            </span>
                          </span>
                        </span>
                        <span className="truncate text-ui text-muted-foreground max-sm:hidden">{entry.note}</span>
                        <span className="text-right text-ui font-medium text-foreground tabular-nums">{formatMinutes(entry.minutes)}</span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </section>
          )}
        </div>
      )}

      <LockOfferDialog offer={offer} onClose={() => setOffer(null)} onLocked={lockedNow} />
      <LocksDialog open={locksOpen} onClose={() => setLocksOpen(false)} workspaceAdmin={workspaceAdmin} onSaved={lockedNow} />
    </div>
  )
}
