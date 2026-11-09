import { useCallback, useState } from "react"
import { Navigate, useParams } from "react-router"
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import { ShareDialog } from "@/components/files/ShareDialog"
import { Recent } from "@/components/icons"
import { DocActions, DocLoadError, useDocLoad } from "@/components/papers/docPage"
import { DocTitle } from "@/components/papers/DocTitle"
import LiveBoard, { type BoardPanel } from "@/components/papers/LiveBoard"
import { printBoard } from "@/components/papers/printDoc"
import { PageHeader } from "@/components/shell/PageHeader"
import { Button } from "@/components/ui/button"
import { NotFoundView } from "@/components/ui/not-found-view"
import { Skeleton } from "@/components/ui/skeleton"
import type { DocLevel } from "@/lib/api/files"
import { useDocumentTitle } from "@/lib/useDocumentTitle"

const LEVEL_TAG: Record<Exclude<DocLevel, "edit">, string> = { view: "View only", comment: "Can comment" }

/** Where a board file opens, full page and live */
export default function BoardPage() {
  const { id = "" } = useParams<{ id: string }>()
  const { load, setLoad, read } = useDocLoad(id, "Couldn't open the board. Try again.")
  const [sharing, setSharing] = useState(false)
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [panel, setPanel] = useState<BoardPanel | null>(null)
  const reread = useCallback(() => void read(), [read])

  const meta = load.status === "ready" ? load.meta : null
  useDocumentTitle(meta?.file.name ?? (load.status === "missing" ? "Not found" : null), "Files")

  if (meta?.docType === "paper") return <Navigate to={`/paper/${id}`} replace />

  if (load.status === "missing") {
    return <NotFoundView title="This board wandered off" text="It may be in the trash, or you no longer have access." />
  }
  if (load.status === "error") return <DocLoadError error={load.error} onRetry={reread} />

  return (
    <div
      data-full-bleed=""
      data-phone-bleed=""
      className="flex h-full min-h-[28rem] flex-col gap-3 p-4 pb-[max(1rem,var(--chat-space,0rem))] lg:p-6 lg:pb-[max(1.5rem,var(--chat-space,0rem))]"
    >
      <PageHeader
        title={
          meta ? (
            <DocTitle meta={meta} onRenamed={(name) => setLoad({ status: "ready", meta: { ...meta, file: { ...meta.file, name } } })} />
          ) : (
            <Skeleton className="h-[2rem] w-[16rem]" />
          )
        }
        meta={
          meta &&
          meta.level !== "edit" && (
            <span className="inline-flex h-6 items-center rounded-md bg-app-sunk px-2 text-caption font-medium text-muted-foreground">
              {LEVEL_TAG[meta.level]}
            </span>
          )
        }
        actions={
          meta && (
            <>
              {meta.level === "edit" && (
                <Button
                  type="button"
                  variant="secondary"
                  aria-label="Version history"
                  title="Version history"
                  aria-expanded={panel === "history"}
                  onClick={() => setPanel((was) => (was === "history" ? null : "history"))}
                  className="px-2 max-lg:px-3"
                >
                  <Recent aria-hidden="true" className="size-[1rem]" />
                </Button>
              )}
              <DocActions meta={meta} onDownload={api ? () => void printBoard(api) : undefined} onShare={() => setSharing(true)} />
            </>
          )
        }
      />
      {meta ? (
        <LiveBoard fileId={id} level={meta.level} thumbnail panel={panel} onPanel={setPanel} onAccessChange={reread} onApi={setApi} />
      ) : (
        <Skeleton className="min-h-[20rem] flex-1 rounded-lg" />
      )}
      {meta && <ShareDialog row={sharing ? { kind: "file", item: meta.file } : null} onClose={() => setSharing(false)} />}
    </div>
  )
}
