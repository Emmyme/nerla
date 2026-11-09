import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import { NodeViewWrapper } from "@tiptap/react"
import * as Y from "yjs"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useBoardComments } from "./boardComments"
import { CommentsPanel, useCommentShortcut } from "./CommentsPanel"
import { useDocCommentsContext } from "./commentsStore"
import type { BoardBlockOptions } from "./extensions/boardBlock"
import { printBoard } from "./printDoc"

const BoardPreview = lazy(() => import("./BoardPreview"))
const BoardCanvas = lazy(() => import("./BoardCanvas"))

/** The paper's boards, one map of elements per board block */
export const boardsOf = (doc: Y.Doc) => doc.getMap<unknown>("boards")

/** A board's entry, made when missing. Only an editor makes one */
export function ensureBoard(doc: Y.Doc, boardId: string): Y.Map<unknown> {
  const boards = boardsOf(doc)
  const found = boards.get(boardId)
  if (found instanceof Y.Map) return found
  const made = new Y.Map<unknown>()
  boards.set(boardId, made)
  return made
}

function useBoardEntry(doc: Y.Doc | null, boardId: string | null): Y.Map<unknown> | null {
  const read = () => {
    const found = doc && boardId ? boardsOf(doc).get(boardId) : null
    return found instanceof Y.Map ? found : null
  }
  const [map, setMap] = useState(read)
  useEffect(() => {
    if (!doc) return
    const boards = boardsOf(doc)
    const update = () => setMap(read())
    update()
    boards.observe(update)
    return () => boards.unobserve(update)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read is rebuilt each render from doc and boardId
  }, [doc, boardId])
  return map
}

/**
 * Escape closes the board only when Excalidraw has nothing of its own to cancel. A selection doesn't count, as Escape
 * keeps it, but a drawing tool does, as Escape goes back to the pointer
 */
const idle = (api: ExcalidrawImperativeAPI | null) => {
  if (!api) return true
  const state = api.getAppState()
  return (
    state.activeTool.type === "selection" &&
    !state.editingTextElement &&
    !state.editingLinearElement &&
    !state.multiElement &&
    !state.croppingElementId &&
    !state.contextMenu &&
    !state.newElement &&
    !state.openDialog &&
    !state.openMenu &&
    !state.openPopup &&
    !state.openSidebar
  )
}

const TABBABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'
// Layers of their own that may hold focus while the board is open, such as the comments sheet on a phone, a call coming
// in or a toast
const OWN_LAYER = '[role="dialog"], [role="alertdialog"], [data-side-panel], [data-sonner-toaster], [data-incoming-calls]'

/** Focuses the first control Tab reaches in the board, or the last, leaving out the two edges that wrap it */
function focusEnd(root: HTMLElement, end: "first" | "last") {
  const list = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) =>
      element.tabIndex >= 0 && !element.hasAttribute("data-focus-edge") && !element.matches(":disabled") && !element.closest("[inert]"),
  )
  if (end === "last") list.reverse()
  // Excalidraw keeps some controls in the page but out of sight, and those refuse focus
  for (const element of list) {
    element.focus()
    if (document.activeElement === element) return
  }
}

function FullScreenBoard({
  map,
  boardId,
  options,
  host,
  onClose,
}: {
  map: Y.Map<unknown>
  boardId: string
  options: BoardBlockOptions
  host: Element
  onClose: () => void
}) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const done = useRef<HTMLButtonElement>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => done.current?.focus(), [])
  // The paper's comments, for commenters and editors only
  const paperComments = useDocCommentsContext()
  const [panel, setPanel] = useState(false)
  const board = useBoardComments({ comments: paperComments, api, boardId, open: panel, setOpen: setPanel })
  useCommentShortcut(board.comment, { enabled: !!paperComments, within: root })

  // An unsent comment or reply stays, as closing the board would drop it
  const drafting = () =>
    !!board.pending ||
    Array.from(document.querySelectorAll<HTMLTextAreaElement>("[data-side-panel] textarea")).some((field) => field.value.trim() !== "")
  // Escape closes only when neither Excalidraw nor a tool's own popup has something open, and nothing is being written
  const closes = (key: string) =>
    key === "Escape" && idle(api) && !drafting() && !root.current?.querySelector('[aria-haspopup="dialog"][aria-expanded="true"]')

  const onKeyDown = (event: KeyboardEvent) => {
    // The comments panel handles its own keys, and on a phone it is a sheet outside this dialog
    if (
      !(event.target instanceof Node) ||
      !root.current?.contains(event.target) ||
      (event.target as Element).closest?.("[data-side-panel]")
    )
      return
    if (closes(event.key)) {
      event.stopPropagation()
      onClose()
    }
  }

  // Tab stays in the board: the edges send focus round to the other end
  const wrapTo = (end: "first" | "last") => () => root.current && focusEnd(root.current, end)

  // Focus that lands outside, or drops to the page when a control under it goes away, comes back
  const closeRef = useRef(closes)
  closeRef.current = closes
  const closeNow = useRef(onClose)
  closeNow.current = onClose
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !root.current || root.current.contains(target) || target.closest(OWN_LAYER)) return
      done.current?.focus()
    }
    const onPageKey = (event: globalThis.KeyboardEvent) => {
      if (document.activeElement !== document.body || !root.current) return
      if (event.key === "Tab") {
        event.preventDefault()
        focusEnd(root.current, event.shiftKey ? "last" : "first")
      } else if (closeRef.current(event.key)) {
        event.stopPropagation()
        closeNow.current()
      }
    }
    document.addEventListener("focusin", onFocusIn)
    document.addEventListener("keydown", onPageKey, true)
    return () => {
      document.removeEventListener("focusin", onFocusIn)
      document.removeEventListener("keydown", onPageKey, true)
    }
  }, [])

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="Board"
      onKeyDownCapture={onKeyDown}
      // React passes events up through the portal to the block, whose drag handle must not start a drag of the block
      onDragStart={(event) => event.stopPropagation()}
      className="fixed inset-0 z-50 flex flex-col bg-app-bg text-app-text"
    >
      <span data-focus-edge="" tabIndex={0} onFocus={wrapTo("last")} className="sr-only" />
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2">
        <span className="text-ui font-medium text-muted-foreground">Board</span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" disabled={!api} onClick={() => api && void printBoard(api)}>
            Download PDF
          </Button>
          <Button ref={done} type="button" variant="sky" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 lg:pr-3 lg:pb-3">
        <div className="min-h-0 min-w-0 flex-1">
          <Suspense fallback={<Skeleton className="m-4 h-[calc(100%-2rem)] rounded-lg" />}>
            <BoardCanvas
              map={map}
              level={options.level}
              fullScreen
              fileId={options.fileId ?? ""}
              boardKey={boardId}
              awareness={options.live?.provider?.awareness ?? null}
              access={options.access}
              canUpload={options.canUpload}
              onApi={setApi}
              pins={paperComments ? board.pins : undefined}
              activePin={paperComments?.activeId ?? null}
              onPin={board.openPin}
              onComments={paperComments ? board.comment : undefined}
              commentsOpen={panel}
            />
          </Suspense>
        </div>
        {panel && board.comments && (
          <CommentsPanel
            comments={board.comments}
            pending={board.pending}
            onPendingDone={board.pendingDone}
            viewOf={board.viewOf}
            emptyText="No comments on this board yet. Select something, then Comments."
            onNew={board.newComment}
            onClose={board.close}
            className="lg:w-[22rem] lg:shrink-0"
          />
        )}
      </div>
      <span data-focus-edge="" tabIndex={0} onFocus={wrapTo("first")} className="sr-only" />
    </div>,
    host,
  )
}

/** A board inside the paper: a live picture of it, opened full screen to draw */
export function BoardBlockView({ boardId, selected, options }: { boardId: string | null; selected: boolean; options: BoardBlockOptions }) {
  const doc = options.live?.doc ?? null
  const map = useBoardEntry(doc, boardId)
  const editable = options.level === "edit"
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<"loading" | "ready">(map ? "loading" : "ready")
  const [empty, setEmpty] = useState(!map)
  const opener = useRef<HTMLButtonElement>(null)
  const anchor = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!map) {
      setState("ready")
      setEmpty(true)
    }
  }, [map])

  const show = () => {
    if (!doc || !boardId) return
    if (!map && editable) ensureBoard(doc, boardId)
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    requestAnimationFrame(() => opener.current?.focus())
  }
  const canOpen = !!boardId && !!doc && (editable || !!map)
  // Looked up from outside the block, whose own light scope must not hold the full screen board, so it mounts at page
  // level, out of the editor's DOM, with the dark controls a dark page has
  const host = (anchor.current?.parentElement?.closest("[data-mode]:not(html)") as Element | null) ?? document.body

  return (
    <NodeViewWrapper
      ref={anchor}
      contentEditable={false}
      data-drag-handle=""
      data-board-preview={state}
      // A board is a light sheet in either mode, so its candy colors stay bright
      data-theme="nerla"
      data-mode="light"
      className={cn(
        "paper-board relative my-3 flex aspect-[16/7] items-center justify-center overflow-hidden rounded-lg bg-app-surface ring-[0.0625rem] ring-border",
        selected && "ring-[0.125rem] ring-ring",
      )}
    >
      {map ? (
        <Suspense fallback={<Skeleton className="absolute inset-3 rounded-md" />}>
          <BoardPreview
            map={map}
            docId={options.fileId ?? ""}
            access={options.access}
            onReady={(nothing) => {
              setEmpty(nothing)
              setState("ready")
            }}
          />
        </Suspense>
      ) : (
        <span className="text-ui text-muted-foreground">Empty board</span>
      )}
      {canOpen && (
        <Button
          ref={opener}
          type="button"
          variant={empty && editable ? "sky" : "secondary"}
          size="sm"
          data-print="hide"
          onClick={show}
          className="absolute top-2 right-2"
        >
          {editable ? (empty ? "Draw" : "Edit board") : "Open board"}
        </Button>
      )}
      {open && map && boardId && <FullScreenBoard map={map} boardId={boardId} options={options} host={host} onClose={close} />}
    </NodeViewWrapper>
  )
}
