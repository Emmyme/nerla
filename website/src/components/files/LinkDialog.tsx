import { useEffect, useId, useRef, useState } from "react"
import { toast } from "sonner"
import { Copy } from "@/components/icons"
import { LoadingSpinner } from "@/components/ui/spinner"
import { copyToClipboard } from "@/components/settings/InviteDialog"
import { LoadError } from "@/components/settings/LoadState"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { fileSharingAPI, type FileShareLink, type LinkExpiry } from "@/lib/api/fileSharing"
import { formatShortDate, formatTime, parseServerDate } from "@/lib/dates"
import { messageOf } from "@/lib/taskStore"
import { cn } from "@/lib/utils"
import type { RowItem } from "./FileRowMenu"

const EXPIRIES: { value: LinkExpiry; label: string }[] = [
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "never", label: "Never" },
]

const COPY_FAILED = "Couldn't copy the link. Select it and copy it yourself."
const SHOWN_LINKS = 3
const LOAD_FAILED = "Couldn't load the links."

export const downloadCount = (count: number) => (count === 1 ? "1 download" : `${count} downloads`)

export function expiryText(expiresAt: string | null): string {
  if (!expiresAt) return "Never expires"
  return `Expires ${formatShortDate(parseServerDate(expiresAt) ?? expiresAt)}`
}

/** "expires 2 Nov, 1 download", which tells one link's buttons from another's */
export const linkFacts = (link: { expiresAt: string | null; downloadCount: number }) =>
  `${expiryText(link.expiresAt).toLowerCase()}, ${downloadCount(link.downloadCount)}`

/**
 * Makes an outside link to a file or folder and lists the active ones. A workspace admin who cannot make a
 * link here sees the list without urls, so they can turn links off but not share them
 */
export function LinkDialog({ row, onClose }: { row: RowItem | null; onClose: () => void }) {
  const [links, setLinks] = useState<FileShareLink[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [expiry, setExpiry] = useState<LinkExpiry>("7d")
  const [fresh, setFresh] = useState<FileShareLink | null>(null)
  const [creating, setCreating] = useState(false)
  const [turningOff, setTurningOff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const ids = useId()
  const kind = row?.kind
  const id = row?.item.id
  const canCreate = !!row?.item.can.includes("link")

  useEffect(() => {
    setFresh(null)
    setExpiry("7d")
    setError(null)
    setShowAll(false)
  }, [kind, id])

  useEffect(() => {
    if (!kind || !id) return
    let live = true
    setLinks(null)
    setLoadError(null)
    fileSharingAPI.links(kind, id).then(
      (next) => live && setLinks(next),
      (err: unknown) => live && setLoadError(messageOf(err, LOAD_FAILED)),
    )
    return () => {
      live = false
    }
  }, [kind, id, attempt])

  const copy = async (url: string, input?: HTMLInputElement | null) => {
    if (await copyToClipboard(url, input)) toast.success("Link copied")
    else toast.error(COPY_FAILED)
  }

  const create = async () => {
    if (!kind || !id) return
    setCreating(true)
    setError(null)
    try {
      const link = await fileSharingAPI.createLink(kind, id, expiry)
      setFresh(link)
      setLinks((current) => [link, ...(current ?? [])])
      requestAnimationFrame(() => field.current?.select())
    } catch (err) {
      setError(messageOf(err, "Couldn't create the link. Try again."))
    } finally {
      setCreating(false)
    }
  }

  const turnOff = async (link: FileShareLink) => {
    const rows = links ?? []
    const at = rows.findIndex((l) => l.id === link.id)
    const next = rows[at + 1] ?? rows[at - 1]
    setTurningOff(link.id)
    setError(null)
    try {
      await fileSharingAPI.turnOffLink(link.id)
      setLinks((current) => current && current.filter((l) => l.id !== link.id))
      if (fresh?.id === link.id) setFresh(null)
      toast.success("Link turned off")
      requestAnimationFrame(() => {
        const target = (next && list.current?.querySelector<HTMLElement>(`[data-turn-off="${next.id}"]`)) || heading.current
        target?.focus()
      })
    } catch (err) {
      setError(messageOf(err, "Couldn't turn the link off. Try again."))
    } finally {
      setTurningOff(null)
    }
  }

  const title = row ? `${canCreate ? "Link to" : "Links to"} ${row.item.name}` : "Links"

  return (
    <BaseModal isOpen={row !== null} onClose={onClose} title={title} maxWidth="md">
      <div className="flex flex-col gap-5 p-6">
        {canCreate && (
          <div className="flex flex-col gap-2">
            <label htmlFor={`${ids}-expiry`} className="text-ui font-medium text-muted-foreground">
              Expires after
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={expiry} onValueChange={(value) => setExpiry(value as LinkExpiry)}>
                <SelectTrigger id={`${ids}-expiry`} className="w-[9rem] border-transparent bg-app-sunk font-medium">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRIES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" onClick={() => void create()} disabled={creating} aria-busy={creating || undefined}>
                Create link
              </Button>
            </div>
            <p className="text-caption text-muted-foreground">Anyone with the link can view and download this.</p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <h3 ref={heading} tabIndex={-1} className="text-ui font-semibold text-foreground outline-none">
            Active links
          </h3>
          {loadError ? (
            <LoadError message={loadError} onRetry={() => setAttempt((n) => n + 1)} />
          ) : links === null ? (
            <p role="status" className="flex items-center gap-2 text-ui text-muted-foreground">
              <LoadingSpinner aria-hidden="true" />
              Loading
            </p>
          ) : links.length === 0 ? (
            <p className="text-ui text-muted-foreground">No active links</p>
          ) : (
            <>
              <ul ref={list} aria-label="Active links" className="flex flex-col gap-0.5 rounded-lg bg-app-sunk p-1">
                {(showAll ? links : links.slice(0, SHOWN_LINKS)).map((link) => {
                  const madeAt = parseServerDate(link.createdAt)
                  const created = formatShortDate(madeAt ?? link.createdAt)
                  const facts = `${linkFacts(link)}, made ${created}${madeAt ? ` at ${formatTime(madeAt)}` : ""}`
                  const isNew = fresh?.id === link.id && !!link.url
                  return (
                    <li
                      key={link.id}
                      className={cn(
                        "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md py-1 pr-1 pl-2.5",
                        isNew && "gap-y-2 bg-card py-2 pr-2 ring-[0.0625rem] ring-border",
                      )}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-center gap-2 text-ui font-medium text-foreground">
                          {expiryText(link.expiresAt)}
                          {isNew && (
                            <span className="rounded-full bg-app-pistachio px-1.5 text-micro leading-[1.25rem] font-semibold text-app-pistachio-ink">
                              New
                            </span>
                          )}
                        </span>
                        <span className="text-caption text-muted-foreground tabular-nums">
                          <span className="whitespace-nowrap">Made {created}</span> ·{" "}
                          <span className="whitespace-nowrap">{downloadCount(link.downloadCount)}</span>
                        </span>
                      </span>
                      {link.url && !isNew && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Copy link, ${facts}`}
                          onClick={() => void copy(link.url!)}
                        >
                          <Copy aria-hidden="true" className="size-[0.9rem]" />
                          Copy
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-app-berry-text"
                        data-turn-off={link.id}
                        aria-label={`Turn off link, ${facts}`}
                        disabled={turningOff === link.id}
                        aria-busy={turningOff === link.id || undefined}
                        onClick={() => void turnOff(link)}
                      >
                        Turn off
                      </Button>
                      {isNew && (
                        <div className="flex basis-full flex-col gap-2 sm:flex-row">
                          <Input
                            ref={field}
                            readOnly
                            value={link.url!}
                            aria-label="New link"
                            onFocus={(event) => event.currentTarget.select()}
                            className="min-w-0 font-mono text-caption text-foreground sm:flex-1"
                          />
                          <Button type="button" variant="sky" className="shrink-0" onClick={() => void copy(link.url!, field.current)}>
                            <Copy aria-hidden="true" className="size-[1rem]" />
                            Copy link
                          </Button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
              {links.length > SHOWN_LINKS && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  aria-expanded={showAll}
                  onClick={() => setShowAll((all) => !all)}
                >
                  {showAll ? "Show fewer" : `Show all ${links.length}`}
                </Button>
              )}
            </>
          )}
        </div>

        {error && (
          <p role="alert" className="text-ui text-app-berry-text">
            {error}
          </p>
        )}
      </div>
    </BaseModal>
  )
}
