import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { toast } from "sonner"
import * as Y from "yjs"
import { markedVia } from "@/components/ai/via"
import { ViaMark } from "@/components/ai/ViaMark"
import { X } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { papersAPI, type DocVersion } from "@/lib/api/papers"
import { fromBase64 } from "@/lib/base64"
import { formatRelative, formatShortDate, formatTime, parseServerDate } from "@/lib/dates"
import { FADE_MOTION } from "@/lib/motion"
import { messageOf } from "@/lib/taskStore"
import { cn, keepToasts } from "@/lib/utils"
import { SidePanel } from "./CommentsPanel"

// A version carries no mark of why it was saved, so one without named editors reads plainly
const editorsOf = (version: DocVersion) =>
  version.editors.length ? version.editors.map((editor) => editor.name).join(", ") : "Saved automatically"

/** Who it was edited by, with the robot when their agent or AI made the edit */
function Editors({ version, inside }: { version: DocVersion; inside: boolean }) {
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
      <span className="truncate">{editorsOf(version)}</span>
      {markedVia(version.done_via) && (
        <ViaMark
          via={version.done_via}
          personName={version.editors[0]?.name ?? "Someone"}
          verb={version.created ? "Created" : "Done"}
          inside={inside}
        />
      )}
    </span>
  )
}

function fullTime(at: string) {
  const date = parseServerDate(at)
  return date ? `${formatShortDate(date)} ${formatTime(date)}` : ""
}

/** One version, read only, with the way back to it */
function VersionPreview({
  fileId,
  version,
  shareId,
  renderPreview,
  onRestored,
  onClose,
}: {
  fileId: string
  version: DocVersion
  shareId?: string | null
  renderPreview: (doc: Y.Doc) => ReactNode
  onRestored: () => void
  onClose: () => void
}) {
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [failed, setFailed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const restoreButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    let made: Y.Doc | null = null
    setDoc(null)
    setFailed(false)
    papersAPI.version(fileId, version.id, shareId).then(
      ({ state }) => {
        if (!live) return
        made = new Y.Doc()
        Y.applyUpdate(made, fromBase64(state))
        setDoc(made)
      },
      () => live && setFailed(true),
    )
    return () => {
      live = false
      made?.destroy()
    }
  }, [fileId, version.id, shareId])

  const restore = async () => {
    setRestoring(true)
    setError(null)
    try {
      await papersAPI.restore(fileId, version.id, shareId)
      toast.success("Version restored")
      onRestored()
    } catch (err) {
      setError(messageOf(err, "Couldn't restore this version. Try again."))
      setRestoring(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !restoring && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={cn("fixed inset-0 z-50 bg-app-scrim", FADE_MOTION)} />
        <Dialog.Content
          onInteractOutside={keepToasts}
          aria-describedby={undefined}
          className={cn(
            "modal-content-in fixed z-50 flex flex-col bg-card text-foreground outline-none",
            "max-lg:inset-x-0 max-lg:top-titlebar max-lg:bottom-0",
            "lg:top-1/2 lg:left-1/2 lg:h-[min(48rem,calc(100dvh-4rem))] lg:w-[min(64rem,calc(100%-4rem))] lg:-translate-x-1/2 lg:-translate-y-1/2 lg:rounded-xl lg:shadow-[var(--shadow-popover)] lg:ring-[0.0625rem] lg:ring-border",
          )}
        >
          <header className="flex shrink-0 items-center gap-2 py-2 pr-2 pl-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-body font-semibold text-foreground">{fullTime(version.createdAt)}</Dialog.Title>
              <Editors version={version} inside={false} />
            </div>
            <Dialog.Close
              aria-label="Close version"
              title="Close"
              className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:size-11"
            >
              <X aria-hidden="true" className="size-[1rem]" />
            </Dialog.Close>
          </header>
          <div className="relative min-h-0 flex-1 overflow-y-auto bg-background px-4 py-3">
            {failed ? (
              <p role="alert" className="text-ui text-app-berry-text">
                Couldn't open this version. Try again.
              </p>
            ) : doc ? (
              renderPreview(doc)
            ) : (
              <>
                <span role="status" className="sr-only">
                  Opening the version
                </span>
                <Skeleton className="h-full min-h-[12rem] rounded-lg" />
              </>
            )}
          </div>
          <footer
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !confirming || restoring) return
              event.preventDefault()
              event.stopPropagation()
              setConfirming(false)
              requestAnimationFrame(() => restoreButton.current?.focus())
            }}
            className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          >
            {error && (
              <p role="alert" className="mr-auto text-ui text-app-berry-text">
                {error}
              </p>
            )}
            {confirming ? (
              <>
                <p className="mr-auto text-ui font-medium text-foreground">
                  Restore this version? The current version is kept in the history.
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  autoFocus
                  disabled={restoring}
                  onClick={() => {
                    setConfirming(false)
                    requestAnimationFrame(() => restoreButton.current?.focus())
                  }}
                >
                  Cancel
                </Button>
                <Button type="button" variant="sky" disabled={restoring} onClick={() => void restore()}>
                  {restoring ? "Restoring" : "Restore"}
                </Button>
              </>
            ) : (
              <Button ref={restoreButton} type="button" variant="sky" disabled={!doc} onClick={() => setConfirming(true)}>
                Restore this version
              </Button>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** A paper's or board's saved versions, for editors, newest first */
export function VersionHistory({
  fileId,
  shareId,
  renderPreview,
  onClose,
  className,
}: {
  fileId: string
  shareId?: string | null
  /** The version, read only, with no live connection */
  renderPreview: (doc: Y.Doc) => ReactNode
  onClose: () => void
  className?: string
}) {
  const [versions, setVersions] = useState<DocVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<DocVersion | null>(null)

  const read = useCallback(() => {
    setError(null)
    papersAPI.versions(fileId, shareId).then(setVersions, (err: unknown) => setError(messageOf(err, "Couldn't load the history.")))
  }, [fileId, shareId])

  useEffect(() => read(), [read])

  return (
    <SidePanel title="Version history" onClose={onClose} className={className}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
        {error ? (
          <p role="alert" className="px-2 text-ui text-app-berry-text">
            {error}{" "}
            <button type="button" onClick={read} className="cursor-pointer font-medium underline underline-offset-2">
              Try again
            </button>
          </p>
        ) : versions === null ? (
          <div aria-hidden="true" className="flex flex-col gap-2 px-2">
            <Skeleton className="h-[2.75rem] rounded-lg" />
            <Skeleton className="h-[2.75rem] rounded-lg" />
            <Skeleton className="h-[2.75rem] rounded-lg" />
          </div>
        ) : versions.length === 0 ? (
          <p className="px-2 py-2 text-ui text-muted-foreground">No versions yet. Nerla saves one as people edit.</p>
        ) : (
          <ol aria-label="Versions" className="flex flex-col gap-0.5">
            {versions.map((version) => {
              const date = parseServerDate(version.createdAt)
              return (
                <li key={version.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(version)}
                    className={cn(
                      "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
                      open?.id === version.id && "bg-app-selected hover:bg-app-selected",
                    )}
                  >
                    <time
                      dateTime={date?.toISOString()}
                      title={fullTime(version.createdAt)}
                      className="text-ui font-medium text-foreground"
                    >
                      {date ? formatRelative(date) : ""}
                    </time>
                    <Editors version={version} inside />
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </div>
      {open && (
        <VersionPreview
          fileId={fileId}
          version={open}
          shareId={shareId}
          renderPreview={renderPreview}
          onRestored={() => {
            setOpen(null)
            read()
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </SidePanel>
  )
}
