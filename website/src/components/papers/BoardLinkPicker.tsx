import { useEffect, useState } from "react"
import { Board, Search } from "@/components/icons"
import { LoadingSpinner } from "@/components/ui/spinner"
import BaseModal from "@/components/ui/BaseModal"
import { fileBrowserAPI, type FileItem } from "@/lib/api/files"
import { formatShortDate } from "@/lib/dates"
import { messageOf } from "@/lib/taskStore"

const SEARCH_DELAY_MS = 200

/** Picks a board to show inside the paper */
export function BoardLinkPicker({ open, onPick, onClose }: { open: boolean; onPick: (board: FileItem) => void; onClose: () => void }) {
  const [text, setText] = useState("")
  const [boards, setBoards] = useState<FileItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const query = text.trim()

  useEffect(() => {
    if (open) setText("")
  }, [open])

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    setBoards(null)
    setError(null)
    const timer = setTimeout(
      () =>
        fileBrowserAPI.search({ q: query || undefined, type: "board" }, abort.signal).then(
          (listing) => !abort.signal.aborted && setBoards(listing.files),
          (err: unknown) => {
            if (!abort.signal.aborted) setError(messageOf(err, "Couldn't load your boards. Try again."))
          },
        ),
      query ? SEARCH_DELAY_MS : 0,
    )
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [open, query])

  return (
    <BaseModal isOpen={open} onClose={onClose} title="Link a board" maxWidth="md">
      <div className="flex flex-col gap-3 p-6">
        <label className="relative flex items-center">
          <span className="sr-only">Search boards</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 size-[0.95rem] text-muted-foreground" />
          <input
            autoFocus
            type="search"
            placeholder="Search boards"
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="h-8 w-full rounded-md bg-app-sunk pr-2.5 pl-8 text-ui text-foreground placeholder:text-muted-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:h-11 [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
        {error ? (
          <p role="alert" className="text-ui text-app-berry-text">
            {error}
          </p>
        ) : boards === null ? (
          <p role="status" className="flex items-center gap-2 text-ui text-muted-foreground">
            <LoadingSpinner aria-hidden="true" />
            Loading
          </p>
        ) : boards.length === 0 ? (
          <p className="text-ui text-muted-foreground">{query ? `No boards found for “${query}”` : "No boards yet"}</p>
        ) : (
          <ul className="flex max-h-[20rem] flex-col gap-0.5 overflow-y-auto">
            {boards.map((board) => (
              <li key={board.id}>
                <button
                  type="button"
                  onClick={() => onPick(board)}
                  className="flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-[1.75rem] shrink-0 items-center justify-center rounded-md bg-app-pistachio-soft text-app-pistachio-ink"
                  >
                    <Board className="size-[1rem]" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{board.name}</span>
                  <span className="shrink-0 text-caption text-muted-foreground">{formatShortDate(board.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </BaseModal>
  )
}
