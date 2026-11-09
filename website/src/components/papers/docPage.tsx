import { useCallback, useEffect, useState } from "react"
import { Download, Share } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { ApiError } from "@/lib/api/request"
import { papersAPI, type DocMeta } from "@/lib/api/papers"
import { messageOf } from "@/lib/taskStore"

type DocLoad = { status: "loading" } | { status: "ready"; meta: DocMeta } | { status: "missing" } | { status: "error"; error: string }

/** Reads a paper's or board's meta when `id` changes and on `read()`. A document already open stays open when a later read fails */
export function useDocLoad(id: string, failed: string) {
  const [load, setLoad] = useState<DocLoad>({ status: "loading" })

  const read = useCallback(
    (signal?: AbortSignal) =>
      papersAPI.get(id, null, signal).then(
        (meta) => setLoad({ status: "ready", meta }),
        (err: unknown) => {
          if (signal?.aborted) return
          if (err instanceof ApiError && err.status === 404) return setLoad({ status: "missing" })
          setLoad((current) => (current.status === "ready" ? current : { status: "error", error: messageOf(err, failed) }))
        },
      ),
    [id, failed],
  )

  useEffect(() => {
    const abort = new AbortController()
    setLoad({ status: "loading" })
    void read(abort.signal)
    return () => abort.abort()
  }, [read])

  return { load, setLoad, read }
}

export function DocLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div role="alert" className="mx-auto flex max-w-[24rem] flex-col items-center gap-3 px-4 py-20 text-center">
      <p className="text-body text-muted-foreground">{error}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

/** Download PDF and Share, icons only on a phone so the title keeps its room */
export function DocActions({ meta, onDownload, onShare }: { meta: DocMeta; onDownload?: () => void; onShare: () => void }) {
  return (
    <>
      <Button type="button" variant="secondary" disabled={!onDownload} onClick={onDownload} className="max-lg:px-3">
        <Download aria-hidden="true" className="size-[1rem] lg:hidden" />
        <span className="max-lg:sr-only">Download PDF</span>
      </Button>
      {meta.file.can.includes("share") && (
        <Button type="button" variant="secondary" onClick={onShare} className="max-lg:px-3">
          <Share aria-hidden="true" className="size-[1rem] lg:hidden" />
          <span className="max-lg:sr-only">Share</span>
        </Button>
      )}
    </>
  )
}
