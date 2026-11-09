import { useEffect, useState } from "react"
import { ChevronRight } from "@/components/icons"
import { LoadingSpinner } from "@/components/ui/spinner"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { fileBrowserAPI, type FolderItem } from "@/lib/api/files"
import { messageOf } from "@/lib/taskStore"
import { Breadcrumbs } from "./Breadcrumbs"
import type { RowItem } from "./FileRowMenu"
import { FolderGlyph } from "./FolderGlyph"
import type { TrailStep } from "./useFiles"

const parentOf = (row: RowItem) => (row.kind === "file" ? row.item.folderId : row.item.parentId)

/** Picks a folder to move a row into, within the row's own place, by keyboard as well as by drag */
export function MoveDialog({
  row,
  rootLabel,
  onMove,
  onClose,
  fallbackFocus,
}: {
  row: RowItem | null
  rootLabel: string
  onMove: (row: RowItem, folderId: string | null) => Promise<void>
  onClose: () => void
  /** Where focus goes when the moved row has left the list */
  fallbackFocus?: () => HTMLElement | null
}) {
  // Where the dialog is browsing, starting at the row's own folder, so opening it costs one request
  const [nav, setNav] = useState<{ row: RowItem | null; at: string | null }>({ row: null, at: null })
  const at = nav.row === row ? nav.at : row ? parentOf(row) : null
  const setAt = (next: string | null) => setNav({ row, at: next })
  const [listing, setListing] = useState<{ folders: FolderItem[]; trail: TrailStep[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const folders = listing?.folders ?? null

  useEffect(() => {
    setError(null)
  }, [row])

  const projectId = row?.item.projectId ?? null
  useEffect(() => {
    if (!row) return
    const abort = new AbortController()
    setListing(null)
    fileBrowserAPI.browse({ section: projectId ? "project" : "mine", projectId, folderId: at, sort: "name" }, abort.signal).then(
      (next) => setListing({ folders: next.folders, trail: next.trail ?? [] }),
      (err: unknown) => {
        if (abort.signal.aborted) return
        setListing({ folders: [], trail: [] })
        setError(messageOf(err, "Couldn't load folders. Try again."))
      },
    )
    return () => abort.abort()
  }, [row, at, projectId])

  const move = async () => {
    if (!row) return
    setMoving(true)
    setError(null)
    try {
      await onMove(row, at)
      onClose()
    } catch (err) {
      setError(messageOf(err, "Couldn't move it. Try again."))
    } finally {
      setMoving(false)
    }
  }

  const trail = at ? (listing?.trail ?? []) : []
  const crumbs = [{ id: null, name: rootLabel }, ...trail.slice(0, -1)]
  const here = at ? (trail.at(-1)?.name ?? "") : rootLabel
  const choices = (folders ?? []).filter((folder) => !(row?.kind === "folder" && folder.id === row.item.id))
  const unchanged = row !== null && parentOf(row) === at

  return (
    <BaseModal
      isOpen={row !== null}
      onClose={() => !moving && onClose()}
      title={row ? `Move ${row.item.name}` : "Move"}
      maxWidth="md"
      fallbackFocus={fallbackFocus}
    >
      <div className="flex flex-col gap-3 p-6">
        <div className="flex min-h-[2rem] flex-wrap items-center gap-0.5">
          {at !== null && <Breadcrumbs crumbs={crumbs} onOpen={setAt} />}
          <span className="truncate px-1.5 text-body font-semibold text-foreground">{here}</span>
        </div>
        <ul
          aria-label="Folders"
          aria-busy={folders === null}
          className="flex max-h-[18rem] min-h-[8rem] flex-col gap-0.5 overflow-y-auto rounded-lg bg-app-sunk p-1"
        >
          {folders === null ? (
            <li role="status" className="flex items-center gap-2 px-2.5 py-2 text-ui text-muted-foreground">
              <LoadingSpinner aria-hidden="true" />
              Loading folders
            </li>
          ) : choices.length === 0 ? (
            <li className="px-2.5 py-2 text-ui text-muted-foreground">No folders here</li>
          ) : (
            choices.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  onClick={() => setAt(folder.id)}
                  className="flex min-h-[2rem] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-ui font-medium text-foreground transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset max-lg:min-h-11"
                >
                  <FolderGlyph color={folder.color} className="w-[1.125rem]" />
                  <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                  <ChevronRight aria-hidden="true" className="size-[0.9rem] shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))
          )}
        </ul>
        {error && (
          <p role="alert" className="text-ui text-app-berry-text">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={moving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void move()} disabled={moving || unchanged} aria-busy={moving || undefined}>
            Move here
          </Button>
        </div>
      </div>
    </BaseModal>
  )
}
