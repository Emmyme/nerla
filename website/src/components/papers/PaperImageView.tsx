import { useEffect, useState } from "react"
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { Image } from "@/components/icons"
import type { DocAccess } from "@/lib/api/papers"
import { cn } from "@/lib/utils"
import { leaseDocImage, type DocImageLease } from "./docImages"

export function PaperImageView({ node, selected, extension }: ReactNodeViewProps) {
  const fileId = typeof node.attrs.fileId === "string" ? node.attrs.fileId : null
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : ""
  const { access, docId } = extension.options as { access: () => Promise<DocAccess>; docId: string }
  const [state, setState] = useState<{ id: string | null; url: string | null; failed: boolean }>({ id: null, url: null, failed: false })

  useEffect(() => {
    if (!fileId) return
    let live = true
    // The image holds its URL while it is mounted, so the cache never revokes it from under it
    let lease: DocImageLease | null = null
    access()
      .then((granted) => {
        if (!live) return null
        lease = leaseDocImage(fileId, docId, granted)
        return lease.url
      })
      .then(
        (url) => live && url && setState({ id: fileId, url, failed: false }),
        () => live && setState({ id: fileId, url: null, failed: true }),
      )
    return () => {
      live = false
      lease?.release()
    }
  }, [fileId, docId, access])

  const shown = state.id === fileId ? state : { url: null, failed: false }
  return (
    <NodeViewWrapper data-drag-handle="" className="paper-image my-3">
      {shown.url ? (
        <img src={shown.url} alt={alt} draggable={false} className={cn("max-w-full rounded-lg", selected && "ring-[0.125rem] ring-ring")} />
      ) : (
        <span
          role={shown.failed ? "img" : undefined}
          aria-label={shown.failed ? "This image couldn't load" : undefined}
          className={cn(
            "flex aspect-[16/9] max-w-full items-center justify-center rounded-lg bg-app-sunk text-muted-foreground",
            !shown.failed && "animate-pulse",
            selected && "ring-[0.125rem] ring-ring",
          )}
        >
          <Image aria-hidden="true" className="size-[1.5rem]" />
        </span>
      )}
    </NodeViewWrapper>
  )
}
