import { useEffect, useId, useRef, useState } from "react"
import { toast } from "sonner"
import { Check } from "@/components/icons"
import { ConfirmDialog } from "@/components/settings/ConfirmDialog"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { DateInput } from "@/components/ui/DateInput"
import { Skeleton } from "@/components/ui/skeleton"
import { timeAPI, type TimeLock } from "@/lib/api/time"
import { messageOf } from "@/lib/taskStore"
import { cn } from "@/lib/utils"
import { dayName } from "./timeView"

const LOCK_FAILED = "Couldn't lock the hours. Try again."
const LOAD_FAILED = "Couldn't load the locks. Try again."
const SAVE_FAILED = "Couldn't save the locks. Try again."
const MAX_IDS = 500

const datesOf = (locks: TimeLock[]) => Object.fromEntries(locks.map((lock) => [lock.projectId, lock.lockedUntil ?? ""]))

const projectCount = (count: number) => (count === 1 ? "1 project" : `${count} projects`)

function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: string }) {
  return (
    <label className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-ui text-foreground hover:bg-app-hover max-lg:min-h-11">
      <input type="checkbox" checked={checked} onChange={onChange} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={cn(
          "flex size-[1rem] shrink-0 items-center justify-center rounded-sm peer-focus-visible:outline-[0.125rem] peer-focus-visible:outline-offset-[0.125rem] peer-focus-visible:outline-ring",
          checked ? "bg-app-sky text-app-sky-ink" : "ring-[0.125rem] ring-input ring-inset",
        )}
      >
        {checked && <Check weight="bold" className="size-[0.7rem]" />}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </label>
  )
}

/** After an export: lock the exported projects through its last day, each one checked to start with */
export function LockOfferDialog({
  offer,
  onClose,
  onLocked,
}: {
  offer: { until: string; projects: TimeLock[] } | null
  onClose: () => void
  onLocked: (locks: TimeLock[]) => void
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bodyId = useId()

  useEffect(() => {
    if (!offer) return
    setChecked(new Set(offer.projects.map((project) => project.projectId)))
    setError(null)
  }, [offer])

  const lock = async () => {
    if (!offer || !checked.size || saving) return
    setSaving(true)
    setError(null)
    try {
      onLocked(await timeAPI.setLocks([...checked], offer.until))
      toast.success(`Locked until ${dayName(offer.until)}`)
      onClose()
    } catch (err) {
      setError(messageOf(err, LOCK_FAILED))
    } finally {
      setSaving(false)
    }
  }

  return (
    <BaseModal
      isOpen={!!offer}
      onClose={() => !saving && onClose()}
      title={offer ? `Lock these hours until ${dayName(offer.until)}?` : "Lock these hours?"}
      maxWidth="sm"
      describedBy={bodyId}
    >
      <div className="flex flex-col gap-4 p-6">
        <p id={bodyId} className="text-body leading-[1.5] text-muted-foreground">
          Locked hours can't be changed or deleted, so the export stays true.
        </p>
        <fieldset className="-mx-2 flex flex-col">
          <legend className="sr-only">Projects to lock</legend>
          {offer?.projects.map((project) => (
            <CheckRow
              key={project.projectId}
              checked={checked.has(project.projectId)}
              onChange={() =>
                setChecked((shown) => {
                  const next = new Set(shown)
                  if (!next.delete(project.projectId)) next.add(project.projectId)
                  return next
                })
              }
            >
              {project.name}
            </CheckRow>
          ))}
        </fieldset>
        {error && (
          <p role="alert" className="text-ui text-app-berry-text">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Not now
          </Button>
          <Button type="button" aria-disabled={!checked.size || undefined} aria-busy={saving || undefined} onClick={() => void lock()}>
            {saving ? "Locking" : "Lock"}
          </Button>
        </div>
      </div>
    </BaseModal>
  )
}

/** Every lock date the caller may set, and for a workspace admin one date that extends every project's lock */
export function LocksDialog({
  open,
  onClose,
  workspaceAdmin,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  workspaceAdmin: boolean
  onSaved: (locks: TimeLock[]) => void
}) {
  const [locks, setLocks] = useState<TimeLock[] | null>(null)
  const [dates, setDates] = useState<Record<string, string>>({})
  const [allDate, setAllDate] = useState("")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const saveButton = useRef<HTMLButtonElement>(null)
  const ids = useId()

  const show = (next: TimeLock[]) => {
    setLocks(next)
    setDates(datesOf(next))
    onSaved(next)
  }

  useEffect(() => {
    if (!open) return
    let live = true
    setLocks(null)
    setLoadError(null)
    setError(null)
    setAllDate("")
    timeAPI.locks().then(
      (found) => {
        if (!live) return
        setLocks(found)
        setDates(datesOf(found))
      },
      (err) => live && setLoadError(messageOf(err, LOAD_FAILED)),
    )
    return () => {
      live = false
    }
  }, [open])

  const changed = (locks ?? []).filter((lock) => (dates[lock.projectId] ?? "") !== (lock.lockedUntil ?? ""))
  // A cleared date, or one moved earlier, frees hours that were locked
  const unlocking = changed.filter((lock) => {
    const until = dates[lock.projectId] ?? ""
    return !until || (!!lock.lockedUntil && until < lock.lockedUntil)
  })

  // Every project in a request gets the same date, so one request per date, in batches the server takes
  const send = async (byDate: Map<string, string[]>) => {
    let next: TimeLock[] | undefined
    for (const [until, projectIds] of byDate)
      for (let at = 0; at < projectIds.length; at += MAX_IDS)
        next = await timeAPI.setLocks(projectIds.slice(at, at + MAX_IDS), until || null)
    if (next) show(next)
    toast.success("Locks saved")
  }

  const run = async (work: () => Promise<void>) => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(messageOf(err, SAVE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  const changedByDate = () => {
    const byDate = new Map<string, string[]>()
    for (const lock of changed) {
      const until = dates[lock.projectId] ?? ""
      byDate.set(until, [...(byDate.get(until) ?? []), lock.projectId])
    }
    return byDate
  }

  const save = () => {
    if (!changed.length) return
    if (unlocking.length) setConfirming(true)
    else void run(() => send(changedByDate()))
  }

  // Lock all only ever extends: a project locked on or after the date keeps its own
  const lockAll = () => {
    if (!allDate || !locks) return
    const later = locks.filter((lock) => !lock.lockedUntil || lock.lockedUntil < allDate).map((lock) => lock.projectId)
    if (!later.length) {
      toast("Every project is already locked through that date")
      return
    }
    void run(() => send(new Map([[allDate, later]])))
  }

  return (
    <BaseModal
      isOpen={open}
      onClose={() => !saving && onClose()}
      title="Locks"
      subtitle="Hours on or before a project's date can't be changed. Clear a date to unlock."
      maxWidth="md"
    >
      <div className="flex flex-col gap-4 p-6">
        {workspaceAdmin && locks && locks.length > 0 && (
          <div className="flex flex-wrap items-end gap-2 border-b-[0.0625rem] border-border pb-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor={`${ids}-all`} className="text-caption font-medium text-muted-foreground">
                Lock all projects until
              </label>
              <DateInput id={`${ids}-all`} value={allDate} onChange={setAllDate} className="h-8 text-ui max-lg:h-11" />
            </div>
            <Button type="button" variant="outline" aria-disabled={!allDate || undefined} onClick={lockAll}>
              Lock all
            </Button>
          </div>
        )}
        {loadError ? (
          <p role="alert" className="text-ui text-app-berry-text">
            {loadError}
          </p>
        ) : !locks ? (
          <div className="flex flex-col gap-2">
            <span role="status" className="sr-only">
              Loading locks
            </span>
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} aria-hidden="true" className="h-8 w-full" />
            ))}
          </div>
        ) : locks.length === 0 ? (
          <p className="text-ui text-muted-foreground">No projects to lock.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {locks.map((lock) => (
              <li key={lock.projectId} className="flex items-center gap-3">
                <label htmlFor={`${ids}-${lock.projectId}`} className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
                  {lock.name}
                </label>
                <DateInput
                  id={`${ids}-${lock.projectId}`}
                  value={dates[lock.projectId] ?? ""}
                  onChange={(value) => setDates((shown) => ({ ...shown, [lock.projectId]: value }))}
                  className="h-8 w-[9.5rem] text-ui max-lg:h-11"
                />
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-ui text-app-berry-text">
            {error}
          </p>
        )}
        {locks && locks.length > 0 && (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Close
            </Button>
            <Button
              ref={saveButton}
              type="button"
              aria-disabled={!changed.length || undefined}
              aria-busy={saving || undefined}
              onClick={save}
            >
              {saving ? "Saving" : "Save"}
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        title="Unlock hours?"
        confirmLabel="Unlock"
        busyLabel="Saving"
        failed={SAVE_FAILED}
        onClose={() => setConfirming(false)}
        fallbackFocus={() => saveButton.current}
        onConfirm={() => send(changedByDate())}
      >
        This unlocks hours on {projectCount(unlocking.length)}.
      </ConfirmDialog>
    </BaseModal>
  )
}
