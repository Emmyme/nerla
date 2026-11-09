import { useEffect, useId, useMemo, useState } from "react"
import { Check, ChevronRight, Search, X } from "@/components/icons"
import { LoadingSpinner } from "@/components/ui/spinner"
import { fileIcon } from "@/components/tasks/AttachmentPreview"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { fileBrowserAPI, type FileItem, type FileListing, type FolderItem } from "@/lib/api/files"
import { formatShortDate } from "@/lib/dates"
import { messageOf } from "@/lib/taskStore"
import { useProjects } from "@/lib/useProjects"
import { cn } from "@/lib/utils"
import { Breadcrumbs } from "./Breadcrumbs"
import { fileKind, formatFileSize } from "./fileKinds"
import { FolderGlyph } from "./FolderGlyph"
import type { TrailStep } from "./useFiles"

const PICK_MAX = 10
const SEARCH_DELAY_MS = 200
const LOAD_FAILED = "Couldn't load your files. Try again."

type Scope = "mine" | "project" | "shared"
type Listing = { folders: FolderItem[]; files: FileItem[]; trail: TrailStep[]; nextCursor: string | null }

/**
 * Only what may go here: the user's own files, and the files of this place's project. A file shared with the user
 * would spread access, so it has to be saved to their files first
 */
function attachable(file: FileItem, scope: Scope, projectId: string | null): boolean {
  if (!file.can.includes("attach")) return false
  return scope === "mine" ? file.projectId === null : file.projectId === projectId
}

function useListing(open: boolean, scope: Scope, projectId: string | null, folderId: string | null, query: string, docs: boolean) {
  const [state, setState] = useState<{ key: string; listing: Listing | null; error: string | null; more: boolean }>({
    key: "",
    listing: null,
    error: null,
    more: false,
  })
  const key = `${scope}:${folderId}:${query}`
  const project = scope === "project" ? projectId : null

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    const run = () => {
      // A paper or board to show can be any one the user can open, so its search looks everywhere
      const request: Promise<FileListing> = query
        ? fileBrowserAPI.search(
            docs ? { q: query } : scope === "mine" ? { q: query, owner: "me" } : { q: query, projectId: project ?? undefined },
            abort.signal,
          )
        : fileBrowserAPI.browse({ section: scope, projectId: project, folderId, sort: "name" }, abort.signal)
      request.then(
        (next) =>
          setState({
            key,
            listing: {
              folders: query ? [] : next.folders,
              files: next.files,
              trail: next.trail ?? [],
              nextCursor: query ? null : next.nextCursor,
            },
            error: null,
            more: false,
          }),
        (err: unknown) => {
          if (!abort.signal.aborted) setState({ key, listing: null, error: messageOf(err, LOAD_FAILED), more: false })
        },
      )
    }
    const timer = query ? setTimeout(run, SEARCH_DELAY_MS) : undefined
    if (!query) run()
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [open, key, scope, project, folderId, query, docs])

  const current = state.key === key ? state : { key, listing: null, error: null, more: false }
  const loadMore = () => {
    const cursor = current.listing?.nextCursor
    if (!cursor || current.more) return
    setState((s) => ({ ...s, more: true }))
    fileBrowserAPI.browse({ section: scope, projectId: project, folderId, sort: "name", cursor }).then(
      (next) =>
        setState((s) =>
          s.key === key && s.listing
            ? { ...s, more: false, listing: { ...s.listing, files: [...s.listing.files, ...next.files], nextCursor: next.nextCursor } }
            : s,
        ),
      () => setState((s) => ({ ...s, more: false })),
    )
  }
  return { ...current, loadMore }
}

/**
 * Picks up to ten files already in Nerla to attach, from the user's own files or, inside a project, from its files.
 * With `docs` it picks one paper or board the user can open, their own or shared with them
 */
export function FilePicker({
  open,
  projectId,
  docs = false,
  onPick,
  onClose,
}: {
  open: boolean
  projectId: string | null
  docs?: boolean
  onPick: (files: FileItem[]) => void
  onClose: () => void
}) {
  const [scope, setScope] = useState<Scope>("mine")
  const [folderId, setFolderId] = useState<string | null>(null)
  const [text, setText] = useState("")
  const [picked, setPicked] = useState<Map<string, FileItem>>(new Map())
  const footerId = useId()
  const { projects } = useProjects()
  const projectName = projects.find((p) => p.id === projectId)?.name ?? "Project files"
  const query = text.trim()
  const { listing, error, more, loadMore } = useListing(open, scope, projectId, folderId, query, docs)

  useEffect(() => {
    if (!open) return
    setScope("mine")
    setFolderId(null)
    setText("")
    setPicked(new Map())
  }, [open])

  const files = useMemo(
    () => listing?.files.filter((file) => (docs ? file.docType !== null && !file.deletedAt : attachable(file, scope, projectId))) ?? [],
    [listing, scope, projectId, docs],
  )
  const full = picked.size >= PICK_MAX
  const rootName = scope === "mine" ? "My files" : scope === "shared" ? "Shared with me" : projectName
  const scopes: { value: Scope; label: string }[] = [
    { value: "mine", label: "My files" },
    ...(docs ? [{ value: "shared" as const, label: "Shared with me" }] : []),
    ...(projectId ? [{ value: "project" as const, label: projectName }] : []),
  ]

  const toggle = (file: FileItem) =>
    setPicked((current) => {
      const next = new Map(current)
      if (next.has(file.id)) next.delete(file.id)
      else if (next.size < PICK_MAX) next.set(file.id, file)
      return next
    })

  const switchScope = (next: Scope) => {
    setScope(next)
    setFolderId(null)
  }

  const trail = folderId && !query ? (listing?.trail ?? []) : []
  const crumbs = [{ id: null, name: rootName }, ...trail.slice(0, -1)]
  const here = query ? `Results for “${query}”` : folderId ? (trail.at(-1)?.name ?? "") : rootName

  const attach = () => {
    onPick([...picked.values()])
    onClose()
  }

  return (
    <BaseModal
      isOpen={open}
      onClose={onClose}
      title={docs ? "Share a paper or board" : "Attach from Nerla"}
      maxWidth="md"
      describedBy={docs ? undefined : footerId}
    >
      <div className="flex min-h-0 flex-col gap-3 p-6 max-lg:p-4">
        <div className="flex flex-wrap items-center gap-2">
          {scopes.length > 1 && (
            <SegmentedControl<Scope>
              label="Files from"
              value={scope}
              onChange={switchScope}
              options={scopes}
              className="max-w-full [&>button]:min-w-0 [&>button]:truncate"
            />
          )}
          <label className="relative flex min-w-[10rem] flex-1 items-center">
            <span className="sr-only">{docs ? "Search papers and boards" : "Search files"}</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 size-[0.95rem] text-muted-foreground" />
            <input
              type="search"
              value={text}
              placeholder={docs ? "Search papers and boards" : "Search files"}
              onChange={(event) => setText(event.target.value)}
              className="h-8 w-full rounded-md bg-app-sunk pr-8 pl-8 text-ui text-foreground placeholder:text-muted-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:h-11 max-lg:pr-11 [&::-webkit-search-cancel-button]:hidden"
            />
            {text && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setText("")}
                className="absolute right-1 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:right-0 max-lg:size-11"
              >
                <X aria-hidden="true" className="size-[0.85rem]" />
              </button>
            )}
          </label>
        </div>

        <div className="flex min-h-[2rem] min-w-0 items-center gap-0.5">
          {trail.length > 0 && <Breadcrumbs crumbs={crumbs} onOpen={setFolderId} />}
          <span className="truncate px-1.5 text-ui font-semibold text-foreground">{here}</span>
        </div>

        <div
          aria-busy={!listing && !error}
          className="flex h-[18rem] flex-col gap-0.5 overflow-y-auto rounded-lg bg-app-sunk p-1 max-lg:h-[min(18rem,45dvh)]"
        >
          {error ? (
            <p role="alert" className="px-2.5 py-2 text-ui text-app-berry-text">
              {error}
            </p>
          ) : !listing ? (
            <p role="status" className="flex items-center gap-2 px-2.5 py-2 text-ui text-muted-foreground">
              <LoadingSpinner aria-hidden="true" />
              Loading files
            </p>
          ) : listing.folders.length === 0 && files.length === 0 ? (
            <p className="px-2.5 py-2 text-ui text-muted-foreground">
              {query ? (docs ? "No papers or boards match" : "No files match") : docs ? "No papers or boards here" : "No files here"}
            </p>
          ) : (
            <>
              {listing.folders.length > 0 && (
                <ul aria-label="Folders" className="flex flex-col gap-0.5">
                  {listing.folders.map((folder) => (
                    <li key={folder.id}>
                      <button
                        type="button"
                        onClick={() => setFolderId(folder.id)}
                        className="flex min-h-[2.25rem] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-ui font-medium text-foreground transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset max-lg:min-h-11"
                      >
                        <FolderGlyph color={folder.color} className="w-[1.125rem]" />
                        <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                        <ChevronRight aria-hidden="true" className="size-[0.9rem] shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {files.length > 0 && (
                <ul aria-label="Files" className="flex flex-col gap-0.5">
                  {files.map((file) => {
                    const checked = picked.has(file.id)
                    const Icon = fileIcon(file.name, fileKind(file))
                    if (docs) {
                      return (
                        <li key={file.id}>
                          <button
                            type="button"
                            onClick={() => {
                              onPick([file])
                              onClose()
                            }}
                            className="flex min-h-[2.25rem] w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-ui transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset max-lg:min-h-11"
                          >
                            <Icon aria-hidden="true" className="size-[1rem] shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{file.name}</span>
                            <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
                              {formatShortDate(file.updatedAt)}
                            </span>
                          </button>
                        </li>
                      )
                    }
                    return (
                      <li key={file.id}>
                        <label
                          className={cn(
                            "flex min-h-[2.25rem] w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-ui transition-colors duration-150 hover:bg-app-hover has-[:disabled]:cursor-default has-[:disabled]:opacity-50 has-[:disabled]:hover:bg-transparent has-[:focus-visible]:ring-[0.125rem] has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-inset max-lg:min-h-11",
                            checked && "bg-app-selected hover:bg-app-selected",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!checked && full}
                            onChange={() => toggle(file)}
                            className="peer sr-only"
                          />
                          <span
                            aria-hidden="true"
                            className={cn(
                              "flex size-[1rem] shrink-0 items-center justify-center rounded-sm transition-colors duration-150",
                              checked ? "bg-app-pistachio-strong text-app-pistachio-ink" : "bg-card ring-[0.125rem] ring-input ring-inset",
                            )}
                          >
                            {checked && <Check weight="bold" className="size-[0.7rem]" />}
                          </span>
                          <Icon aria-hidden="true" className="size-[1rem] shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{file.name}</span>
                          <span className="shrink-0 text-caption text-muted-foreground tabular-nums max-sm:hidden">
                            {formatShortDate(file.updatedAt)}
                          </span>
                          <span className="w-[3.75rem] shrink-0 text-right text-caption text-muted-foreground tabular-nums">
                            {formatFileSize(file.size)}
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
              {listing.nextCursor && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={loadMore}
                  aria-busy={more || undefined}
                  className="mt-1 self-center"
                >
                  Show more
                </Button>
              )}
            </>
          )}
        </div>

        {!docs && (
          <p id={footerId} className="text-caption text-muted-foreground">
            Files shared with you can be attached after you save them to your files.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!docs && (
            <span role="status" className="mr-auto text-caption font-medium text-muted-foreground tabular-nums">
              {full ? `${PICK_MAX} files is the most at a time` : picked.size > 0 ? `${picked.size} selected` : ""}
            </span>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {!docs && (
            <Button type="button" onClick={attach} disabled={picked.size === 0}>
              {picked.size > 1 ? `Attach ${picked.size} files` : "Attach"}
            </Button>
          )}
        </div>
      </div>
    </BaseModal>
  )
}
