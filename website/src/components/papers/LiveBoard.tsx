import { useCallback, useEffect, useRef, useState } from "react"
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import { WifiSlash } from "@/components/icons"
import { Skeleton } from "@/components/ui/skeleton"
import type { DocAccess } from "@/lib/api/papers"
import type { DocLevel } from "@/lib/api/files"
import { createDocProvider, type DocProvider } from "@/lib/collab"
import { docColor } from "@/lib/docColors"
import { cn } from "@/lib/utils"
import BoardCanvas from "./BoardCanvas"
import { useBoardComments } from "./boardComments"
import { CommentsPanel, useCommentShortcut } from "./CommentsPanel"
import { useDocComments } from "./commentsStore"
import { useLiveStatus } from "./useLiveStatus"
import { VersionHistory } from "./VersionHistory"

export type BoardPanel = "comments" | "history"

/** How the board is reached: the member's own access, a call share, or a guest's doc token */
export type LiveBoardReach = { shareId?: string } | { guestToken: () => Promise<string>; guestName: string }

const SIDE_PANEL = "lg:w-[22rem] lg:shrink-0"

/**
 * A board file's live connection, and the canvas once the first sync is in. The page puts its panels beside the board,
 * the call's panel puts comments under it
 */
export default function LiveBoard({
  fileId,
  level,
  reach = {},
  layout = "page",
  thumbnail = false,
  panel,
  onPanel,
  onAccessChange,
  onApi,
}: {
  fileId: string
  level: DocLevel
  reach?: LiveBoardReach
  layout?: "page" | "call"
  thumbnail?: boolean
  panel: BoardPanel | null
  onPanel: (panel: BoardPanel | null) => void
  onAccessChange: () => void
  onApi?: (api: ExcalidrawImperativeAPI | null) => void
}) {
  const [live, setLive] = useState<DocProvider | null>(null)
  const { synced, offline, denied } = useLiveStatus(live?.provider ?? null, onAccessChange)
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const reachRef = useRef(reach)
  reachRef.current = reach
  const guest = "guestToken" in reach
  const shareId = "shareId" in reach ? reach.shareId : undefined
  const inCall = layout === "call"

  const access = useCallback(async (): Promise<DocAccess> => {
    const now = reachRef.current
    if ("guestToken" in now) return { docToken: await now.guestToken() }
    return now.shareId ? { shareId: now.shareId } : {}
  }, [])

  // Viewers never get comments, so nothing about them mounts for a viewer
  const comments = useDocComments(level !== "view" && live ? { fileId, provider: live.provider, access, member: !guest } : null)
  const board = useBoardComments({
    comments,
    api,
    boardId: null,
    open: panel === "comments",
    setOpen: (open) => onPanel(open ? "comments" : null),
  })
  useCommentShortcut(board.comment, { enabled: !!comments, within: inCall ? box : undefined })

  const shareApi = useCallback(
    (next: ExcalidrawImperativeAPI | null) => {
      setApi(next)
      onApi?.(next)
    },
    [onApi],
  )

  useEffect(() => {
    const now = reachRef.current
    const created = createDocProvider(
      fileId,
      "guestToken" in now ? { guestToken: () => (reachRef.current as { guestToken: () => Promise<string> }).guestToken() } : { shareId },
    )
    // A guest has no account, so other users see the name from the lobby
    if ("guestToken" in now)
      created.provider.awareness?.setLocalStateField("user", { name: now.guestName, color: docColor(String(created.doc.clientID)) })
    setLive(created)
    return () => {
      setLive(null)
      created.destroy()
    }
  }, [fileId, shareId, guest])

  const statusLine = (
    <p role="status" className="flex items-center gap-2 rounded-lg bg-app-sunk px-3 py-1.5 text-ui text-muted-foreground">
      <WifiSlash aria-hidden="true" className="size-[1rem] shrink-0" />
      {denied
        ? synced
          ? "You can't open this board anymore."
          : "You can't open this board."
        : "Offline. Your changes sync when you're back."}
    </p>
  )

  // A refusal before the first sync shows instead of the skeleton
  if (live && !synced && denied) return statusLine
  if (!live || !synced) {
    return (
      <>
        <span role="status" className="sr-only">
          Opening the board
        </span>
        <Skeleton className={cn("flex-1 rounded-lg", inCall ? "min-h-[18rem]" : "min-h-[20rem]")} />
      </>
    )
  }

  return (
    <>
      {(offline || denied) && statusLine}
      <div ref={box} className={cn("flex flex-1 gap-3", inCall ? "min-h-0 flex-col" : "min-h-[20rem]")}>
        <div className={cn("min-w-0 flex-1 overflow-hidden rounded-lg ring-[0.0625rem] ring-border", inCall && "min-h-[18rem]")}>
          <BoardCanvas
            map={live.doc.getMap("board")}
            level={level}
            fileId={fileId}
            awareness={live.provider.awareness}
            access={access}
            canUpload={!guest}
            // A panel beside the board leaves less room for the tools' labels, and the call's panel is narrow anyway
            compact={inCall || panel !== null}
            fullScreen={!inCall}
            thumbnail={thumbnail}
            onApi={shareApi}
            pins={comments ? board.pins : undefined}
            activePin={comments?.activeId ?? null}
            onPin={board.openPin}
            onComments={comments ? board.comment : undefined}
            commentsOpen={panel === "comments"}
          />
        </div>
        {panel === "comments" && comments && (
          <CommentsPanel
            comments={comments}
            pending={board.pending}
            onPendingDone={board.pendingDone}
            viewOf={board.viewOf}
            emptyText="No comments yet. Select something on the board, then Comments."
            onNew={board.newComment}
            onClose={board.close}
            className={inCall ? "max-h-[45%] shrink-0" : SIDE_PANEL}
          />
        )}
        {panel === "history" && level === "edit" && !guest && !inCall && (
          <VersionHistory
            fileId={fileId}
            onClose={() => onPanel(null)}
            renderPreview={(doc) => (
              <div className="h-full min-h-[24rem] overflow-hidden rounded-lg ring-[0.0625rem] ring-border">
                <BoardCanvas map={doc.getMap("board")} level="view" fileId={fileId} />
              </div>
            )}
            className={SIDE_PANEL}
          />
        )}
      </div>
    </>
  )
}
