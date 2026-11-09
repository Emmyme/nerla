import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { ActionMenu, type MenuEntry } from "@/components/files/ActionMenu"
import { AltTextDialog } from "@/components/files/AltTextDialog"
import { docTypeOf, extensionOf, fileKind, formatFileSize, type AttachmentKind } from "@/components/files/fileKinds"
import { capRefusal } from "@/components/files/uploadErrors"
import {
  Board,
  Copy,
  Download,
  Ellipsis,
  File,
  FileArchive,
  FileCode,
  FileDoc,
  FilePdf,
  FileSheet,
  FileSlides,
  FileText,
  Image,
  Music,
  Paper,
  Play,
  Spinner,
  TextLeft,
  Trash,
  Video,
  X,
  type IconComponent,
} from "@/components/icons"
import { ApiError } from "@/lib/api/request"
import { fileBrowserAPI, filesAPI, isRemoved, type Attachment, type TaskAttachment } from "@/lib/api/files"
import { cachedBlobUrl, leaseBlobUrl, type BlobLease } from "@/lib/blobCache"
import { formatLongDate } from "@/lib/dates"
import { messageOf } from "@/lib/taskStore"
import { useSettledInView } from "@/lib/useInView"
import { cn, TAP } from "@/lib/utils"
import { whenSelectionRests } from "./useTaskPanelRoute"

const MB = 1024 * 1024
const EAGER_LIMIT: Partial<Record<AttachmentKind, number>> = { image: 5 * MB, pdf: 10 * MB }

const LETTERED_ICONS = new Set<IconComponent>([FileArchive, FileSheet, FileDoc, FileSlides, FilePdf])

const FILE_ICONS: [IconComponent, string[]][] = [
  [FilePdf, ["pdf"]],
  [FileArchive, ["zip", "rar", "7z", "tar", "gz"]],
  [FileSheet, ["xls", "xlsx", "csv", "ods", "numbers"]],
  [FileDoc, ["doc", "docx", "odt", "rtf", "pages"]],
  [FileSlides, ["ppt", "pptx", "odp", "key"]],
  [FileText, ["txt", "md", "log"]],
  [FileCode, ["json", "js", "ts", "tsx", "html", "css", "xml", "yml", "yaml", "sh", "py", "sql", "svg"]],
]

export const KIND_ICONS: Record<AttachmentKind, IconComponent> = {
  image: Image,
  pdf: FilePdf,
  video: Video,
  audio: Music,
  file: File,
  paper: Paper,
  board: Board,
}

const attachmentKind = (attachment: Pick<TaskAttachment, "file_name" | "mime_type">): AttachmentKind =>
  fileKind({ name: attachment.file_name, mimeType: attachment.mime_type })

export function fileIcon(name: string, kind: AttachmentKind): IconComponent {
  if (kind !== "file") return KIND_ICONS[kind]
  const ext = extensionOf(name)
  return FILE_ICONS.find(([, extensions]) => extensions.includes(ext))?.[0] ?? File
}

/** Saves the file, from the session cache when it is already there */
export async function downloadAttachment(attachment: Pick<TaskAttachment, "id" | "file_name">, readyUrl?: string | null) {
  const ready = readyUrl ?? cachedBlobUrl(attachment.id)
  const url = ready ?? URL.createObjectURL(await filesAPI.downloadFile(attachment.id))
  const link = document.createElement("a")
  link.href = url
  link.download = attachment.file_name
  document.body.appendChild(link)
  link.click()
  link.remove()
  if (!ready) setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export const isMissing = (err: unknown) => err instanceof ApiError && err.status === 404

// An eager preview that is not cached yet waits until the selection rests, so stepping through tasks downloads nothing
function useBlobUrl(id: string, enabled: boolean, waitForRest: boolean, urgent: boolean, onMissing?: () => void) {
  const [state, setState] = useState<{ id: string; url: string | null; failed: boolean }>(() => ({
    id,
    url: enabled ? cachedBlobUrl(id) : null,
    failed: false,
  }))
  const missing = useRef(onMissing)
  missing.current = onMissing

  useLayoutEffect(() => {
    if (!enabled) return
    let active = true
    let lease: BlobLease | undefined
    const start = () => {
      lease = leaseBlobUrl(id, { urgent })
      lease.url.then(
        (url) => {
          if (active) setState((current) => (current.id === id && current.url === url ? current : { id, url, failed: false }))
        },
        (err: unknown) => {
          if (!active) return
          setState({ id, url: null, failed: true })
          if (isMissing(err)) missing.current?.()
        },
      )
    }
    const waiting = waitForRest && !cachedBlobUrl(id)
    const cancel = waiting ? whenSelectionRests(start) : undefined
    if (!waiting) start()
    return () => {
      active = false
      cancel?.()
      lease?.release()
    }
  }, [id, enabled, waitForRest, urgent])

  return state.id === id ? state : { id, url: null, failed: false }
}

function pdfViewerAvailable(): boolean {
  return typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false
}

const TILE = "relative aspect-[4/3] overflow-hidden rounded-lg bg-app-sunk shadow-[0_0_0_0.0625rem_var(--color-border)]"
const OPEN_BUTTON =
  "absolute inset-0 cursor-pointer rounded-lg transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--color-text)_6%,transparent)] focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-inset focus-visible:ring-ring"
const ICON_BOX =
  "flex size-[2.25rem] items-center justify-center rounded-md bg-card text-muted-foreground shadow-[0_0_0_0.0625rem_var(--color-border)]"

function TypeTile({ name, kind, loading = false }: { name: string; kind: AttachmentKind; loading?: boolean }) {
  const Icon = fileIcon(name, kind)
  const ext = extensionOf(name)
  return (
    <span className={cn("flex size-full flex-col items-center justify-center gap-1", loading && "animate-pulse")}>
      <span className={ICON_BOX}>
        <Icon aria-hidden="true" className="size-[1.25rem]" />
      </span>
      {ext && ext.length <= 5 && !LETTERED_ICONS.has(Icon) && (
        <span className="text-micro font-semibold tracking-[0.04em] text-muted-foreground uppercase">{ext}</span>
      )}
    </span>
  )
}

function Caption({ attachment, action, icon }: { attachment: TaskAttachment; action?: ReactNode; icon?: ReactNode }) {
  return (
    <figcaption className="flex min-w-0 items-center gap-2 px-0.5">
      {icon && <span className="flex shrink-0 text-muted-foreground">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        {action ?? (
          <span title={attachment.file_name} className="truncate text-caption font-medium text-foreground">
            {attachment.file_name}
          </span>
        )}
        <span className="text-micro font-medium text-muted-foreground tabular-nums">{formatFileSize(attachment.file_size)}</span>
        {attachment.removal_deadline && (
          <span className="line-clamp-2 text-micro text-muted-foreground">
            From a removed member, deleted on {formatLongDate(attachment.removal_deadline)}
          </span>
        )}
      </span>
    </figcaption>
  )
}

/** Where a posted file was, once its owner moved it to Trash or it was deleted. A quiet row with nothing to open */
function RemovedTile({ className, onRemove, removeLabel }: { className?: string; onRemove?: () => void; removeLabel?: string }) {
  return (
    <div data-removed="" className={cn("flex h-10 min-w-0 items-center gap-2 rounded-lg bg-app-sunk pr-1 pl-2.5", className)}>
      <File aria-hidden="true" className="size-[1rem] shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-caption font-medium text-muted-foreground">File removed</span>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel ?? "Remove"}
          title={removeLabel ?? "Remove"}
          onClick={onRemove}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
            TAP,
          )}
        >
          <X aria-hidden="true" className="size-[0.85rem]" />
        </button>
      )}
    </div>
  )
}

/** What a tile's menu offers besides Download */
type TileActions = {
  /** Save to My files, for a file the user does not already own */
  canSave?: boolean
  /** The uploader may describe an image */
  canDescribe?: boolean
  /** Also offered on a removed file, to take its row away */
  onRemove?: () => void
  removeLabel?: string
}

const DOWNLOAD_FAILED = "Couldn't download the file. Check your connection and try again."
export const FILE_GONE = "This file was removed."

function TileMenu({
  attachment,
  url,
  actions,
  onDescribe,
  onMissing,
}: {
  attachment: TaskAttachment
  url: string | null
  actions: TileActions
  onDescribe: () => void
  onMissing?: () => void
}) {
  const doc = docTypeOf(attachment.mime_type)
  const entries: MenuEntry[] = []
  // A paper or board downloads as PDF from its own page
  if (!doc)
    entries.push({
      label: "Download",
      Icon: Download,
      run: () =>
        void downloadAttachment(attachment, url).catch((err: unknown) => {
          if (isMissing(err) && onMissing) {
            onMissing()
            return void toast.error(FILE_GONE)
          }
          toast.error(DOWNLOAD_FAILED)
        }),
    })
  if (actions.canSave) {
    entries.push({
      label: "Save to my files",
      Icon: Copy,
      run: () =>
        void fileBrowserAPI.copyFile(attachment.id).then(
          () => toast.success(`Saved ${attachment.file_name} to My files`),
          (err: unknown) => toast.error(capRefusal(err) ?? messageOf(err, "Couldn't save the file. Try again.")),
        ),
    })
  }
  if (actions.canDescribe && attachmentKind(attachment) === "image")
    entries.push({ label: "Description…", Icon: TextLeft, run: onDescribe })
  if (actions.onRemove) entries.push({ label: actions.removeLabel ?? "Remove", Icon: Trash, run: actions.onRemove, danger: true })
  // The whole corner is the button, 2.75rem for touch at any width, inside the tile's clipping, with the chip inside it
  return (
    <ActionMenu
      label={`Actions for ${attachment.file_name}`}
      entries={entries}
      trigger={
        <span className="flex size-7 items-center justify-center rounded-md bg-card text-foreground shadow-[0_0_0_0.0625rem_var(--color-border)] transition-colors duration-150">
          <Ellipsis aria-hidden="true" weight="bold" className="size-[1rem]" />
        </span>
      }
      className="absolute top-0 right-0 size-11 items-start justify-end rounded-none bg-transparent p-1 hover:bg-transparent focus-visible:ring-0 aria-expanded:opacity-100 max-lg:size-11 lg:pointer-fine:size-9 lg:pointer-fine:opacity-0 lg:pointer-fine:group-hover/tile:opacity-100 lg:pointer-fine:focus-visible:opacity-100 [&:focus-visible>span]:ring-[0.125rem] [&:focus-visible>span]:ring-ring [&:hover>span]:bg-app-hover [&[aria-expanded=true]>span]:bg-app-hover"
    />
  )
}

type TileProps = {
  onOpen: () => void
  className?: string
  /** The tile's menu, left out where there is nothing to offer */
  actions?: TileActions
  /** The file answered 404, so the tile turns into "File removed" at once */
  onMissing?: () => void
  /** A description saved from the tile, for the post it belongs to */
  onDescribed?: (altText: string | null) => void
}

export function AttachmentPreview({ attachment, ...props }: TileProps & { attachment: Attachment }) {
  if (isRemoved(attachment))
    return <RemovedTile className={props.className} onRemove={props.actions?.onRemove} removeLabel={props.actions?.removeLabel} />
  return <LiveTile attachment={attachment} {...props} />
}

function LiveTile({ attachment, onOpen, className, actions, onMissing, onDescribed }: TileProps & { attachment: TaskAttachment }) {
  const [describing, setDescribing] = useState(false)
  // A description saved here shows at once, before the post is loaded again
  const [savedAlt, setSavedAlt] = useState<string | null | undefined>(undefined)
  const altText = savedAlt !== undefined ? savedAlt : (attachment.alt_text ?? null)
  const kind = attachmentKind(attachment)
  const media = kind === "video" || kind === "audio"
  const eager = attachment.file_size <= (EAGER_LIMIT[kind] ?? 0) && (kind !== "pdf" || pdfViewerAvailable())
  const seen = useSettledInView<HTMLDivElement>(eager && !cachedBlobUrl(attachment.id))
  const [requested, setRequested] = useState(false)
  const blob = useBlobUrl(
    attachment.id,
    (eager && (seen.visible || !!cachedBlobUrl(attachment.id))) || requested,
    !requested,
    requested,
    onMissing,
  )
  const [broken, setBroken] = useState(false)
  const failed = blob.failed || broken
  const url = failed ? null : blob.url
  const openLabel = `Open ${attachment.file_name}`
  const menu = actions && (
    <TileMenu attachment={attachment} url={url} actions={actions} onDescribe={() => setDescribing(true)} onMissing={onMissing} />
  )

  if (media && !failed) {
    const nameButton = (
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel}
        title={attachment.file_name}
        className="cursor-pointer truncate rounded-sm text-left text-caption font-medium text-foreground hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
      >
        {attachment.file_name}
      </button>
    )

    if (!url) {
      const KindIcon = KIND_ICONS[kind]
      return (
        <figure className={cn("group/tile flex min-w-0 flex-col gap-1.5", className)}>
          <div className={TILE}>
            <span className="flex size-full items-center justify-center">
              <span className={cn(ICON_BOX, "rounded-full text-foreground")}>
                {requested ? (
                  <Spinner aria-hidden="true" className="size-[1.1rem] animate-spin" />
                ) : (
                  <Play aria-hidden="true" weight="fill" className="ml-0.5 size-[1rem]" />
                )}
              </span>
            </span>
            <KindIcon aria-hidden="true" className="absolute top-[0.5rem] left-[0.5rem] size-[0.9rem] text-muted-foreground" />
            <button
              type="button"
              aria-label={`Play ${attachment.file_name}`}
              aria-busy={requested || undefined}
              onClick={() => setRequested(true)}
              className={OPEN_BUTTON}
            />
            {menu}
          </div>
          <Caption attachment={attachment} action={nameButton} />
        </figure>
      )
    }

    if (kind === "video") {
      return (
        <figure data-media-open="" className={cn("flex min-w-0 flex-col gap-1.5", className)}>
          <div className={cn(TILE, "aspect-video")}>
            <video src={url} controls autoPlay onError={() => setBroken(true)} className="size-full object-contain" />
          </div>
          <Caption attachment={attachment} action={nameButton} />
        </figure>
      )
    }

    return (
      <figure
        data-media-open=""
        className={cn("flex min-w-0 flex-col gap-2 rounded-lg bg-app-sunk p-2.5 shadow-[0_0_0_0.0625rem_var(--color-border)]", className)}
      >
        <audio src={url} controls autoPlay onError={() => setBroken(true)} className="h-[2.5rem] w-full" />
        <Caption attachment={attachment} action={nameButton} icon={<Music aria-hidden="true" className="size-[1rem]" />} />
      </figure>
    )
  }

  let preview: ReactNode
  if (kind === "image" && url) {
    preview = <img src={url} alt={altText || attachment.file_name} onError={() => setBroken(true)} className="size-full object-cover" />
  } else if (kind === "pdf" && url) {
    preview = (
      <object
        data={`${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
        type="application/pdf"
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute -top-[0.25rem] -left-[0.25rem] h-[calc(100%+0.5rem)] w-[calc(100%+0.5rem)]"
      >
        <TypeTile name={attachment.file_name} kind="pdf" />
      </object>
    )
  } else {
    preview = <TypeTile name={attachment.file_name} kind={kind} loading={eager && !failed} />
  }

  return (
    <figure className={cn("group/tile flex min-w-0 flex-col gap-1.5", className)}>
      <div ref={seen.ref} className={TILE}>
        {preview}
        <button type="button" onClick={onOpen} aria-label={openLabel} title={attachment.file_name} className={OPEN_BUTTON} />
        {menu}
      </div>
      <Caption attachment={attachment} />
      {actions?.canDescribe && (
        <AltTextDialog
          file={describing ? { id: attachment.id, altText } : null}
          onClose={() => setDescribing(false)}
          onSaved={(saved) => {
            setSavedAlt(saved.altText)
            onDescribed?.(saved.altText)
          }}
        />
      )}
    </figure>
  )
}
