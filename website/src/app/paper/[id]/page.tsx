import { useEffect, useState } from "react"
import { Navigate, useParams } from "react-router"
import type { Editor } from "@tiptap/react"
import { ShareDialog } from "@/components/files/ShareDialog"
import { DocActions, DocLoadError, useDocLoad } from "@/components/papers/docPage"
import { DocTitle } from "@/components/papers/DocTitle"
import PaperEditor from "@/components/papers/PaperEditor"
import { printPaper } from "@/components/papers/printDoc"
import { PageHeader } from "@/components/shell/PageHeader"
import { NotFoundView } from "@/components/ui/not-found-view"
import { Skeleton } from "@/components/ui/skeleton"
import { useDocumentTitle } from "@/lib/useDocumentTitle"

export default function PaperPage() {
  const { id = "" } = useParams<{ id: string }>()
  const { load, setLoad, read } = useDocLoad(id, "Couldn't open the paper. Try again.")
  const [sharing, setSharing] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)

  const meta = load.status === "ready" ? load.meta : null
  useDocumentTitle(meta?.file.name ?? (load.status === "missing" ? "Not found" : null), "Files")

  // Ctrl P prints the paper as Download PDF does, never the page around it. Until the editor is ready the browser prints
  const name = meta?.file.name
  useEffect(() => {
    if (!editor) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "p") return
      event.preventDefault()
      void printPaper(editor, name)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [editor, name])

  if (meta?.docType === "board") return <Navigate to={`/board/${id}`} replace />

  if (load.status === "missing") {
    return <NotFoundView title="This paper wandered off" text="It may be in the trash, or you no longer have access." />
  }
  if (load.status === "error") return <DocLoadError error={load.error} onRetry={() => void read()} />

  return (
    // The page widens on desktop while a comments or history panel sits beside the paper
    <div className="mx-auto flex w-full max-w-[48rem] flex-col gap-3 px-4 pt-6 pb-10 max-lg:pt-4 lg:has-[[data-side-panel]]:max-w-[71.5rem]">
      <PageHeader
        title={
          meta ? (
            <DocTitle meta={meta} onRenamed={(name) => setLoad({ status: "ready", meta: { ...meta, file: { ...meta.file, name } } })} />
          ) : (
            <Skeleton className="h-[2rem] w-[16rem]" />
          )
        }
        actions={
          meta && (
            <DocActions
              meta={meta}
              onDownload={editor ? () => void printPaper(editor, meta.file.name) : undefined}
              onShare={() => setSharing(true)}
            />
          )
        }
      />
      {meta && (
        <PaperEditor
          fileId={id}
          level={meta.level}
          projectId={meta.file.projectId}
          onAccessChange={() => void read()}
          onEditor={setEditor}
        />
      )}
      {meta && <ShareDialog row={sharing ? { kind: "file", item: meta.file } : null} onClose={() => setSharing(false)} />}
    </div>
  )
}
