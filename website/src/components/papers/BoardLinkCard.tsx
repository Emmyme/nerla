import { useEffect, useState } from "react"
import { Link } from "react-router"
import { NodeViewWrapper } from "@tiptap/react"
import { Board, Lock } from "@/components/icons"
import { ApiError } from "@/lib/api/request"
import { papersAPI } from "@/lib/api/papers"
import { cn } from "@/lib/utils"

type Load = { status: "loading" } | { status: "ready"; name: string } | { status: "hidden" } | { status: "error" }

/** A board file shown in the paper, by its name and stored picture. A user who can't open the board sees a neutral card */
export function BoardLinkCard({ fileId, selected, member }: { fileId: string | null; selected: boolean; member: boolean }) {
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [picture, setPicture] = useState<string | null>(null)

  useEffect(() => {
    if (!fileId || !member) return setLoad({ status: "hidden" })
    const abort = new AbortController()
    let url: string | null = null
    setLoad({ status: "loading" })
    setPicture(null)
    papersAPI.get(fileId, null, abort.signal).then(
      (meta) => {
        if (abort.signal.aborted) return
        if (meta.docType !== "board") return setLoad({ status: "hidden" })
        setLoad({ status: "ready", name: meta.file.name })
        papersAPI.thumbnail(fileId).then(
          (blob) => {
            if (abort.signal.aborted) return
            url = URL.createObjectURL(blob)
            setPicture(url)
          },
          () => undefined,
        )
      },
      (err: unknown) => {
        if (abort.signal.aborted) return
        setLoad({ status: err instanceof ApiError && [401, 403, 404].includes(err.status) ? "hidden" : "error" })
      },
    )
    return () => {
      abort.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [fileId, member])

  const frame = cn(
    "paper-board my-3 flex overflow-hidden rounded-lg bg-app-surface ring-[0.0625rem] ring-border",
    selected && "ring-[0.125rem] ring-ring",
  )

  if (load.status === "hidden" || load.status === "error") {
    return (
      <NodeViewWrapper
        contentEditable={false}
        data-drag-handle=""
        className={cn(frame, "items-center gap-3 px-4 py-3 text-ui text-muted-foreground")}
      >
        <span aria-hidden="true" className="flex size-[2rem] shrink-0 items-center justify-center rounded-md bg-app-sunk">
          <Lock className="size-[1rem]" />
        </span>
        {load.status === "hidden" ? "You don't have access to this board" : "Couldn't load this board. Try again later."}
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper contentEditable={false} data-drag-handle="" className={cn(frame, "flex-col")}>
      <Link
        to={fileId ? `/board/${fileId}` : "#"}
        draggable={false}
        className="paper-board-link flex flex-col transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      >
        <span
          data-theme="nerla"
          data-mode={picture ? "light" : undefined}
          className="flex aspect-[16/7] items-center justify-center bg-app-sunk"
        >
          {picture ? (
            <img src={picture} alt="" className="size-full object-contain p-3" />
          ) : (
            <Board
              aria-hidden="true"
              className={cn("size-[1.75rem] text-muted-foreground", load.status === "loading" && "animate-pulse")}
            />
          )}
        </span>
        <span className="flex items-center gap-2 px-3 py-2">
          <span
            aria-hidden="true"
            className="flex size-[1.5rem] shrink-0 items-center justify-center rounded-md bg-app-pistachio-soft text-app-pistachio-ink"
          >
            <Board className="size-[0.9rem]" />
          </span>
          <span className="min-w-0 truncate text-ui font-medium text-foreground">{load.status === "ready" ? load.name : "Board"}</span>
        </span>
      </Link>
    </NodeViewWrapper>
  )
}
