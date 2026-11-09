import { useEffect, useLayoutEffect, useRef, useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { Download, X } from "@/components/icons"
import { LoadingSpinner } from "@/components/ui/spinner"
import { downloadAttachment, FILE_GONE, fileIcon, isMissing } from "@/components/tasks/AttachmentPreview"
import { Button } from "@/components/ui/button"
import { leaseBlobUrl } from "@/lib/blobCache"
import { takeMenuOpener } from "@/lib/dialogOpener"
import { FADE_MOTION } from "@/lib/motion"
import { keepToasts } from "@/lib/utils"
import { fileKind, formatFileSize, previewKind, typeKind, type PreviewKind } from "./fileKinds"

/** What a preview needs, from a Files row, a task attachment or a chat message */
export type PreviewFile = {
  id: string
  name: string
  size: number
  mimeType: string | null
  altText?: string | null
}

type Leased = { id: string; url: string | null; text: string | null; failed: boolean; missing: boolean }

function useLeasedFile(id: string | null, kind: PreviewKind): Leased {
  const [state, setState] = useState<Leased>({ id: id ?? "", url: null, text: null, failed: false, missing: false })
  useEffect(() => {
    if (!id || kind === "none") return
    let active = true
    // The preview the user opened goes ahead of every thumbnail waiting to load
    const lease = leaseBlobUrl(id, { urgent: true })
    lease.url
      .then(async (url) => {
        // A blob URL reads locally, so the text costs no second download
        const text = kind === "text" ? await (await fetch(url)).text() : null
        if (active) setState({ id, url, text, failed: false, missing: false })
      })
      .catch((err: unknown) => {
        if (active) setState({ id, url: null, text: null, failed: true, missing: isMissing(err) })
      })
    return () => {
      active = false
      lease.release()
    }
  }, [id, kind])
  return state.id === id ? state : { id: id ?? "", url: null, text: null, failed: false, missing: false }
}

function Message({ file, text, onDownload }: { file: PreviewFile; text: string; onDownload: () => void }) {
  const Icon = fileIcon(file.name, fileKind(file))
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <span className="flex size-[3rem] items-center justify-center rounded-lg bg-app-sunk text-muted-foreground">
        <Icon aria-hidden="true" className="size-[1.5rem]" />
      </span>
      <p className="text-body text-muted-foreground">{text}</p>
      <Button type="button" variant="sky" onClick={onDownload}>
        <Download aria-hidden="true" className="size-[1rem]" />
        Download
      </Button>
    </div>
  )
}

/** Opens a file in Nerla when its type and size allow it, and offers the download either way */
export function FilePreviewDialog({
  file,
  onClose,
  onMissing,
}: {
  file: PreviewFile | null
  onClose: () => void
  /** The file answered 404, so whatever showed it can say it was removed */
  onMissing?: (id: string) => void
}) {
  const kind = file ? previewKind(file.mimeType, file.size, file.name) : "none"
  // A browser without a PDF viewer gets the download straight away, with nothing fetched first
  const noViewer = kind === "pdf" && typeof navigator !== "undefined" && navigator.pdfViewerEnabled === false
  const blob = useLeasedFile(file?.id ?? null, noViewer ? "none" : kind)
  const [broken, setBroken] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)
  const [gone, setGone] = useState(false)

  // Opened from a row's menu, focus goes back to that menu's button
  const opener = useRef<HTMLElement | null>(null)
  const open = file !== null
  useLayoutEffect(() => {
    if (open) opener.current = takeMenuOpener()
  }, [open])
  const restoreFocus = (event: Event) => {
    const target = opener.current
    opener.current = null
    if (!target?.isConnected) return
    event.preventDefault()
    target.focus()
  }

  useEffect(() => {
    setBroken(false)
    setDownloadFailed(false)
    setGone(false)
  }, [file?.id])

  const reportMissing = useRef(onMissing)
  reportMissing.current = onMissing
  const missing = blob.missing || gone
  const fileId = file?.id
  useEffect(() => {
    if (missing && fileId) reportMissing.current?.(fileId)
  }, [missing, fileId])

  const download = () => {
    if (!file) return
    setDownloadFailed(false)
    downloadAttachment({ id: file.id, file_name: file.name }, blob.url).catch((err: unknown) => {
      if (isMissing(err)) setGone(true)
      else setDownloadFailed(true)
    })
  }

  const failed = blob.failed || broken
  let body = null
  if (file) {
    if (missing) {
      body = (
        <div role="alert" className="px-6 py-14 text-center text-body text-muted-foreground">
          {FILE_GONE}
        </div>
      )
    } else if (kind === "none") {
      body = (
        <Message
          file={file}
          text={typeKind(file.mimeType, file.name) === "none" ? "This file type can't be previewed." : "Too large to preview."}
          onDownload={download}
        />
      )
    } else if (noViewer) {
      body = <Message file={file} text="This browser can't show PDFs here." onDownload={download} />
    } else if (failed) {
      body = <Message file={file} text="Couldn't load the preview." onDownload={download} />
    } else if (!blob.url) {
      body = (
        <div role="status" className="flex items-center justify-center gap-2 py-20 text-ui text-muted-foreground">
          <LoadingSpinner size="lg" aria-hidden="true" />
          Loading preview
        </div>
      )
    } else if (kind === "image") {
      body = (
        <div className="flex items-center justify-center bg-app-sunk p-4">
          <img
            src={blob.url}
            alt={file.altText || file.name}
            onError={() => setBroken(true)}
            className="max-h-[70vh] max-w-full object-contain"
          />
        </div>
      )
    } else if (kind === "pdf") {
      body = (
        <object data={blob.url} type="application/pdf" aria-label={file.name} className="h-[75vh] w-full">
          <Message file={file} text="This browser can't show PDFs here." onDownload={download} />
        </object>
      )
    } else if (kind === "video") {
      body = (
        <div className="flex justify-center bg-app-sunk">
          <video src={blob.url} controls onError={() => setBroken(true)} aria-label={file.name} className="max-h-[70vh] max-w-full" />
        </div>
      )
    } else if (kind === "audio") {
      body = (
        <div className="px-6 py-10">
          <audio src={blob.url} controls onError={() => setBroken(true)} aria-label={file.name} className="w-full" />
        </div>
      )
    } else {
      body = (
        <pre className="max-h-[70vh] overflow-auto bg-app-sunk p-4 font-mono text-ui break-words whitespace-pre-wrap text-foreground">
          {blob.text}
        </pre>
      )
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={`fixed inset-0 z-50 bg-app-scrim ${FADE_MOTION}`} />
        <Dialog.Content
          onInteractOutside={keepToasts}
          onCloseAutoFocus={restoreFocus}
          aria-modal="true"
          aria-describedby={undefined}
          className="modal-content-in fixed top-1/2 left-1/2 z-50 flex max-h-[92vh] w-[calc(100%-2rem)] max-w-[60rem] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-popover)]"
        >
          <div className="flex items-center gap-3 border-b border-border py-2.5 pr-2.5 pl-5">
            <div className="flex min-w-0 flex-1 flex-col">
              <Dialog.Title className="truncate text-body font-semibold text-foreground">{file?.name ?? "File"}</Dialog.Title>
              {file && <span className="text-caption text-muted-foreground tabular-nums">{formatFileSize(file.size)}</span>}
            </div>
            {downloadFailed && (
              <p role="alert" className="text-ui text-app-berry-text">
                Couldn't download the file.
              </p>
            )}
            {kind !== "none" && !noViewer && !failed && !missing && (
              <Button type="button" variant="ghost" size="sm" onClick={download}>
                <Download aria-hidden="true" className="size-[1rem]" />
                Download
              </Button>
            )}
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Close preview">
                <X aria-hidden="true" className="size-[1.1rem] text-muted-foreground" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">{body}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
