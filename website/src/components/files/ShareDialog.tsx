import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { X } from "@/components/icons"
import { LoadingSpinner } from "@/components/ui/spinner"
import { PeopleSearch, personName, type PersonResult } from "@/components/projects/PeopleSearch"
import { LoadError } from "@/components/settings/LoadState"
import BaseModal from "@/components/ui/BaseModal"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { avatarOf, UserAvatar } from "@/components/ui/user-avatar"
import { fileSharingAPI, type FileGrant, type ShareKind } from "@/lib/api/fileSharing"
import type { DocLevel } from "@/lib/api/files"
import { messageOf } from "@/lib/taskStore"
import { useAuth } from "@/providers/AuthProvider"
import type { RowItem } from "./FileRowMenu"

const LOAD_FAILED = "Couldn't load who this is shared with."

const LEVELS: { value: DocLevel; label: string }[] = [
  { value: "view", label: "Can view" },
  { value: "comment", label: "Can comment" },
  { value: "edit", label: "Can edit" },
]

function LevelSelect({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: DocLevel
  onChange: (level: DocLevel) => void
  disabled?: boolean
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as DocLevel)} disabled={disabled}>
      <SelectTrigger aria-label={label} className="w-auto shrink-0 gap-2 border-transparent bg-transparent font-medium hover:bg-app-hover">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LEVELS.map((level) => (
          <SelectItem key={level.value} value={level.value}>
            {level.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Shares a file or folder the user owns with workspace members, view and download only. A paper or board is shared at a level */
export function ShareDialog({ row, onClose }: { row: RowItem | null; onClose: () => void }) {
  const { user } = useAuth()
  const [grants, setGrants] = useState<FileGrant[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The toast's Undo sits behind the dialog's scrim, so the dialog offers its own while it is open
  const [removed, setRemoved] = useState<FileGrant | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const kind = row?.kind
  const id = row?.item.id
  const isDoc = row?.kind === "file" && !!row.item.docType
  const [newLevel, setNewLevel] = useState<DocLevel>("edit")
  // An Undo from a toast lands after the dialog may have moved on, so it only updates the item still open
  const showing = useRef<string | undefined>(id)
  showing.current = id

  useEffect(() => {
    setError(null)
    setRemoved(null)
    setNewLevel("edit")
  }, [kind, id])

  useEffect(() => {
    if (!kind || !id) return
    let live = true
    setGrants(null)
    setLoadError(null)
    fileSharingAPI.grants(kind, id).then(
      (next) => live && setGrants(next),
      (err: unknown) => live && setLoadError(messageOf(err, LOAD_FAILED)),
    )
    return () => {
      live = false
    }
  }, [kind, id, attempt])

  const shareWith = async (on: { kind: ShareKind; id: string }, userId: string, level?: DocLevel) => {
    const next = await fileSharingAPI.share(on.kind, on.id, [userId], level)
    if (showing.current === on.id) setGrants(next)
  }

  const share = async (person: PersonResult) => {
    if (!kind || !id) return
    setBusy(true)
    setError(null)
    setRemoved(null)
    try {
      await shareWith({ kind, id }, person.id, isDoc ? newLevel : undefined)
      toast.success(`Shared with ${personName(person)}`)
    } catch (err) {
      setError(messageOf(err, "Couldn't share it. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const undo = async (on: { kind: ShareKind; id: string }, grant: FileGrant) => {
    try {
      await shareWith(on, grant.userId, grant.level === "view" ? undefined : grant.level)
      if (showing.current === on.id) setRemoved((current) => (current?.userId === grant.userId ? null : current))
      toast.success(`Shared with ${grant.name}`)
    } catch (err) {
      toast.error(messageOf(err, "Couldn't share it again. Try again."))
    }
  }

  // Sharing again at another level changes it
  const changeLevel = async (grant: FileGrant, level: DocLevel) => {
    if (!kind || !id || level === grant.level) return
    setBusy(true)
    setError(null)
    try {
      await shareWith({ kind, id }, grant.userId, level)
    } catch (err) {
      setError(messageOf(err, "Couldn't change their access. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const unshare = async (grant: FileGrant) => {
    if (!kind || !id) return
    const rows = grants ?? []
    const at = rows.findIndex((g) => g.userId === grant.userId)
    const next = rows[at + 1] ?? rows[at - 1]
    const on = { kind, id }
    setBusy(true)
    setError(null)
    try {
      await fileSharingAPI.unshare(kind, id, grant.userId)
      setGrants((current) => current && current.filter((g) => g.userId !== grant.userId))
      setRemoved(grant)
      toast.success(`Stopped sharing with ${grant.name}`, { action: { label: "Undo", onClick: () => void undo(on, grant) } })
      requestAnimationFrame(() => {
        const target = (next && list.current?.querySelector<HTMLElement>(`[data-unshare="${next.userId}"]`)) || heading.current
        target?.focus()
      })
    } catch (err) {
      setError(messageOf(err, "Couldn't stop sharing. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const exclude = [...(user ? [user.id] : []), ...(grants ?? []).map((grant) => grant.userId)]

  return (
    <BaseModal isOpen={row !== null} onClose={onClose} title={row ? `Share ${row.item.name}` : "Share"} maxWidth="md">
      <div className="flex flex-col gap-5 p-6">
        <div className="flex flex-col gap-1.5">
          <PeopleSearch label="Share with" actionLabel="Share" excludeIds={exclude} busy={busy} onPick={(person) => void share(person)} />
          {isDoc ? (
            <div className="flex items-center gap-1 text-caption text-muted-foreground">
              People you add
              <LevelSelect label="Access for people you add" value={newLevel} onChange={setNewLevel} disabled={busy} />
            </div>
          ) : (
            <p className="text-caption text-muted-foreground">
              People you share with can view and download.
              {row?.kind === "folder" && " They also see everything you add to it later."}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <h3 ref={heading} tabIndex={-1} className="text-ui font-semibold text-foreground outline-none">
            People with access
          </h3>
          {loadError ? (
            <LoadError message={loadError} onRetry={() => setAttempt((n) => n + 1)} />
          ) : grants === null ? (
            <p role="status" className="flex items-center gap-2 text-ui text-muted-foreground">
              <LoadingSpinner aria-hidden="true" />
              Loading
            </p>
          ) : grants.length === 0 ? (
            <p className="text-ui text-muted-foreground">Only you</p>
          ) : (
            <ul ref={list} aria-label="People with access" className="flex flex-col gap-0.5 rounded-lg bg-app-sunk p-1">
              {grants.map((grant) => (
                <li key={grant.userId} className="flex min-h-[2.25rem] items-center gap-2.5 rounded-md pr-1 pl-2">
                  <UserAvatar user={avatarOf({ id: grant.userId, name: grant.name, avatarUrl: grant.avatarUrl })} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{grant.name}</span>
                  {isDoc && (
                    <LevelSelect
                      label={`Access for ${grant.name}`}
                      value={grant.level}
                      onChange={(level) => void changeLevel(grant, level)}
                      disabled={busy}
                    />
                  )}
                  <button
                    type="button"
                    data-unshare={grant.userId}
                    aria-label={`Stop sharing with ${grant.name}`}
                    disabled={busy}
                    onClick={() => void unshare(grant)}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 max-lg:size-11"
                  >
                    <X aria-hidden="true" className="size-[0.9rem]" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {removed && kind && id && (
          <p role="status" className="flex flex-wrap items-center gap-x-2 text-ui text-muted-foreground">
            Stopped sharing with {removed.name}.
            <button
              type="button"
              onClick={() => void undo({ kind, id }, removed)}
              className="rounded-sm font-medium text-foreground underline-offset-[0.2rem] hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
            >
              Undo
            </button>
          </p>
        )}

        {error && (
          <p role="alert" className="text-ui text-app-berry-text">
            {error}
          </p>
        )}
      </div>
    </BaseModal>
  )
}
