import { useMemo, useState } from "react"
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import type { CommentAnchor, CommentThread } from "@/lib/api/papers"
import type { AnchorView } from "./CommentThread"
import { authorName, type DocComments, type Pending } from "./commentsStore"

export type CommentPin = { id: string; x: number; y: number; label: string }

/** The pins of one board's threads. A board file's own pins have no board id */
function pinsOf(threads: CommentThread[], boardId: string | null): CommentPin[] {
  return threads.flatMap(({ root }) =>
    root.anchor?.type === "board" && root.anchor.boardId === boardId
      ? [{ id: root.id, x: root.anchor.x, y: root.anchor.y, label: root.deleted ? "Comment thread" : `Comment by ${authorName(root)}` }]
      : [],
  )
}

/** A spot for a new comment on a board: the top right of what is selected, else the middle of the view */
function boardCommentSpot(api: ExcalidrawImperativeAPI): { x: number; y: number } {
  const state = api.getAppState()
  const selected = api.getSceneElements().filter((element) => state.selectedElementIds[element.id])
  if (selected.length) {
    return {
      x: Math.max(...selected.map((element) => element.x + Math.max(element.width, 0))),
      y: Math.min(...selected.map((element) => element.y + Math.min(element.height, 0))),
    }
  }
  return { x: state.width / 2 / state.zoom.value - state.scrollX, y: state.height / 2 / state.zoom.value - state.scrollY }
}

/** Moves the board so a spot sits in the middle of the view */
function showBoardSpot(api: ExcalidrawImperativeAPI, x: number, y: number) {
  const { width, height, zoom } = api.getAppState()
  api.updateScene({ appState: { scrollX: width / 2 / zoom.value - x, scrollY: height / 2 / zoom.value - y }, captureUpdate: "NEVER" })
}

/**
 * Comments on one board, for the board page and for boards inside a paper. With shapes selected a new comment pins to
 * them, otherwise Comments opens or closes the panel. A board inside a paper shows only its own threads
 */
export function useBoardComments({
  comments,
  api,
  boardId,
  open,
  setOpen,
}: {
  comments: DocComments | null
  api: ExcalidrawImperativeAPI | null
  boardId: string | null
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const [pending, setPending] = useState<Pending | null>(null)
  const pins = useMemo(() => (comments ? pinsOf(comments.threads, boardId) : []), [comments, boardId])
  const scoped = useMemo(() => {
    if (!comments || boardId === null) return comments
    const ids = new Set(pins.map((pin) => pin.id))
    return { ...comments, threads: comments.threads.filter((thread) => ids.has(thread.root.id)) }
  }, [comments, boardId, pins])

  const here = (): Pending | null => (api ? { anchor: { type: "board", boardId, ...boardCommentSpot(api) } } : null)
  const place = boardId ? "On this board" : "On the board"

  return {
    comments: scoped,
    pins,
    pending,
    comment: () => {
      if (!comments || !api) return
      if (Object.keys(api.getAppState().selectedElementIds).length === 0) return setOpen(!open)
      setPending(here())
      setOpen(true)
    },
    newComment: () => setPending(here()),
    openPin: (id: string) => {
      comments?.setActive(id)
      setOpen(true)
    },
    pendingDone: (posted: CommentThread | null) => {
      setPending(null)
      if (posted) comments?.setActive(posted.root.id)
    },
    close: () => {
      setOpen(false)
      setPending(null)
      comments?.setActive(null)
    },
    viewOf: (anchor: CommentAnchor | null): AnchorView =>
      anchor?.type === "board"
        ? { label: place, onShow: () => api && showBoardSpot(api, anchor.x, anchor.y) }
        : { label: anchor ? anchor.quote : place },
  }
}
