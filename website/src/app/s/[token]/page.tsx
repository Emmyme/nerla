import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router"
import catLogo from "@/assets/cat-logo.png"
import { Breadcrumbs } from "@/components/files/Breadcrumbs"
import { FileGlyph } from "@/components/files/FileList"
import { FolderMark } from "@/components/files/FolderGlyph"
import { ChevronRight, Download } from "@/components/icons"
import { LoadingSpinner } from "@/components/ui/spinner"
import { formatFileSize } from "@/components/files/fileKinds"
import { Button } from "@/components/ui/button"
import { ApiError } from "@/lib/api/request"
import { publicLinksAPI, type PublicListing } from "@/lib/api/fileSharing"
import { useDocumentTitle } from "@/lib/useDocumentTitle"

const GONE = "This link has expired or was turned off."
const LOAD_FAILED = "Couldn't load this link. Check your connection and try again."
const MORE_FAILED = "Couldn't load the rest. Check your connection and try again."

// Only these answers mean the link itself is gone, anything else may pass
const isGone = (err: unknown) => err instanceof ApiError && (err.status === 404 || err.status === 410)

type Step = { id: string | null; name: string | null }

const itemCount = (count: number) => (count === 1 ? "1 item" : `${count} items`)

/** What an outside link shows: the file, or the folder and what is inside it, and nothing else of Nerla */
export default function PublicLink() {
  const { token = "" } = useParams()
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  // The open folder lives in the URL, so Back goes up a folder. The names above it ride in the history entry
  const folderId = params.get("folder")
  const saved = (location.state as { trail?: Step[] } | null)?.trail
  const trail: Step[] =
    saved && saved.at(-1)?.id === folderId
      ? saved
      : folderId
        ? [
            { id: null, name: null },
            { id: folderId, name: null },
          ]
        : [{ id: null, name: null }]
  const [listing, setListing] = useState<PublicListing | null>(null)
  const [failed, setFailed] = useState<"gone" | "error" | null>(null)
  const [moreFailed, setMoreFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const first = useRef(true)
  const more = useRef<AbortController | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    setListing(null)
    setFailed(null)
    setMoreFailed(false)
    setLoadingMore(false)
    publicLinksAPI.view(token, { folderId }, abort.signal).then(
      (next) => {
        setListing(next)
        if (!first.current) heading.current?.focus()
        first.current = false
      },
      (err: unknown) => {
        if (!abort.signal.aborted) setFailed(isGone(err) ? "gone" : "error")
      },
    )
    return () => {
      abort.abort()
      more.current?.abort()
    }
  }, [token, folderId, attempt])

  const loadMore = async () => {
    if (!listing?.nextCursor) return
    const abort = new AbortController()
    more.current = abort
    setLoadingMore(true)
    setMoreFailed(false)
    try {
      const next = await publicLinksAPI.view(token, { folderId, cursor: listing.nextCursor }, abort.signal)
      if (abort.signal.aborted) return
      setListing(
        (current) => current && { ...next, folders: [...current.folders, ...next.folders], files: [...current.files, ...next.files] },
      )
    } catch (err) {
      if (abort.signal.aborted) return
      if (isGone(err)) setFailed("gone")
      else setMoreFailed(true)
    } finally {
      if (!abort.signal.aborted) setLoadingMore(false)
    }
  }

  // The steps so far, with the open folder named now that its listing is in
  const named = (): Step[] => trail.map((step, index) => (index === trail.length - 1 && listing ? { ...step, name: listing.name } : step))
  const go = (steps: Step[]) => {
    const id = steps.at(-1)?.id
    navigate({ search: id ? `?folder=${encodeURIComponent(id)}` : "" }, { state: { trail: steps } })
  }

  const name = failed ? null : (listing?.name ?? null)
  useDocumentTitle(name)

  const openCrumb = (id: string | null) => {
    const at = trail.findIndex((step) => step.id === id)
    if (at >= 0) go(named().slice(0, at + 1))
  }

  let body
  if (failed === "gone") {
    body = (
      <p role="alert" className="px-5 py-12 text-center text-body text-muted-foreground">
        {GONE}
      </p>
    )
  } else if (failed === "error") {
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 px-5 py-12 text-center">
        <p className="text-body text-muted-foreground">{LOAD_FAILED}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    )
  } else if (!listing) {
    body = (
      <p role="status" className="flex items-center justify-center gap-2 px-5 py-12 text-ui text-muted-foreground">
        <LoadingSpinner aria-hidden="true" />
        Loading
      </p>
    )
  } else if (listing.kind === "file") {
    const file = listing.files[0]
    body = file ? (
      <div className="flex flex-col items-center gap-4 px-5 py-10 text-center">
        <FileGlyph file={file} className="size-[3rem] rounded-lg [&>svg]:size-[1.5rem]" />
        <div className="flex flex-col gap-1">
          <h1 ref={heading} tabIndex={-1} className="text-title font-semibold wrap-anywhere text-foreground outline-none">
            {file.name}
          </h1>
          <p className="text-ui text-muted-foreground tabular-nums">{formatFileSize(file.size)}</p>
        </div>
        <Button asChild>
          <a href={publicLinksAPI.downloadUrl(token, file.id)} download={file.name}>
            <Download aria-hidden="true" weight="bold" className="size-[1rem]" />
            Download
          </a>
        </Button>
      </div>
    ) : (
      <p role="alert" className="px-5 py-12 text-center text-body text-muted-foreground">
        {GONE}
      </p>
    )
  } else {
    const empty = listing.folders.length === 0 && listing.files.length === 0
    body = (
      <>
        <div className="flex flex-col gap-1 border-b-[0.0625rem] border-border px-5 py-4">
          {trail.length > 1 && <Breadcrumbs crumbs={trail.slice(0, -1)} onOpen={openCrumb} />}
          <h1 ref={heading} tabIndex={-1} className="text-title font-semibold wrap-anywhere text-foreground outline-none">
            {listing.name}
          </h1>
          {!empty && !listing.nextCursor && (
            <p className="text-ui text-muted-foreground tabular-nums">{itemCount(listing.folders.length + listing.files.length)}</p>
          )}
        </div>
        {empty ? (
          <p className="px-5 py-10 text-center text-body text-muted-foreground">This folder is empty.</p>
        ) : (
          <ul aria-label={`In ${listing.name}`} className="flex flex-col p-1.5">
            {listing.folders.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  onClick={() => go([...named(), { id: folder.id, name: folder.name }])}
                  className="flex min-h-[2.75rem] w-full items-center gap-3 rounded-md px-2.5 text-left transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                >
                  <FolderMark />
                  <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{folder.name}</span>
                  <ChevronRight aria-hidden="true" className="size-[0.9rem] shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
            {listing.files.map((file) => (
              <li key={file.id} className="flex min-h-[2.75rem] items-center gap-3 rounded-md pr-1 pl-2.5">
                <FileGlyph file={file} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ui font-medium text-foreground">{file.name}</span>
                  <span className="text-caption text-muted-foreground tabular-nums">{formatFileSize(file.size)}</span>
                </span>
                <Button asChild variant="ghost" size="sm" className="max-sm:px-3">
                  <a href={publicLinksAPI.downloadUrl(token, file.id)} download={file.name} aria-label={`Download ${file.name}`}>
                    <Download aria-hidden="true" className="size-[0.95rem]" />
                    <span className="max-sm:sr-only">Download</span>
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {listing.nextCursor && (
          <div className="flex flex-col items-center gap-2 border-t-[0.0625rem] border-border p-3">
            {moreFailed && (
              <p role="alert" className="text-center text-ui text-muted-foreground">
                {MORE_FAILED}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              aria-busy={loadingMore || undefined}
            >
              {loadingMore ? "Loading" : moreFailed ? "Try again" : "Show more"}
            </Button>
          </div>
        )}
      </>
    )
  }

  return (
    <main className="flex min-h-window flex-col items-center justify-center gap-6 bg-app-bg px-4 py-10">
      <img src={catLogo} alt="Nerla" className="h-10 w-auto" />
      <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card">{body}</div>
    </main>
  )
}
