import { useEffect, useState } from "react"
import { X } from "@/components/icons"
import { fileIcon } from "@/components/tasks/AttachmentPreview"
import { Button } from "@/components/ui/button"
import { leaseBlobUrl } from "@/lib/blobCache"
import { cn, TAP } from "@/lib/utils"
import { AltTextDialog } from "./AltTextDialog"
import { fileKind, formatFileSize, THUMBNAIL_LIMIT } from "./fileKinds"
import type { DraftUpload } from "./useDraftUploads"

/** A picked image of a few MB shows its picture, through the same session cache as Files */
function usePickedThumb(upload: DraftUpload, image: boolean): string | null {
  const id = !upload.preview && !upload.draft && image && upload.size <= THUMBNAIL_LIMIT ? (upload.file?.id ?? null) : null
  const [url, setUrl] = useState<{ id: string; url: string } | null>(null)
  useEffect(() => {
    if (!id) return
    let active = true
    const lease = leaseBlobUrl(id)
    lease.url.then(
      (next) => active && setUrl({ id, url: next }),
      () => {},
    )
    return () => {
      active = false
      lease.release()
    }
  }, [id])
  return upload.preview ?? (url && url.id === id ? url.url : null)
}

function Chip({
  upload,
  onRemove,
  onDescribe,
  disabled,
}: {
  upload: DraftUpload
  onRemove: () => void
  onDescribe: () => void
  disabled: boolean
}) {
  const kind = fileKind({ name: upload.name, mimeType: upload.mimeType })
  const image = kind === "image"
  const thumb = usePickedThumb(upload, image)
  const Icon = fileIcon(upload.name, kind)
  const percent = Math.round(upload.progress * 100)
  const altText = upload.file?.alt_text ?? null
  const describable = image && upload.canDescribe && upload.file !== null

  return (
    <li className="flex h-14 w-60 max-w-full items-center gap-2.5 rounded-md bg-app-sunk pr-1 pl-1.5" title={upload.name}>
      <span className="relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-card text-muted-foreground shadow-[0_0_0_0.0625rem_var(--color-border)]">
        {thumb && !upload.error ? (
          <img src={thumb} alt={altText || upload.name} className="size-full object-cover" />
        ) : (
          <Icon aria-hidden="true" className="size-[1.1rem]" />
        )}
        {!upload.file && !upload.error && thumb && <span aria-hidden="true" className="absolute inset-0 bg-app-scrim" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-caption font-medium text-foreground">{upload.name}</span>
          <span className="ml-auto shrink-0 text-micro text-muted-foreground tabular-nums">
            {upload.file || upload.error ? formatFileSize(upload.size) : `${percent}%`}
          </span>
        </span>
        {upload.error ? (
          <span role="alert" className="truncate text-caption text-app-berry-text" title={upload.error}>
            {upload.error}
          </span>
        ) : !upload.file ? (
          <span
            role="progressbar"
            aria-label={`Uploading ${upload.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="block h-1 w-full overflow-hidden rounded-full bg-border"
          >
            <span
              className="block h-full rounded-full bg-app-sky-strong transition-[width] duration-150"
              style={{ width: `${percent}%` }}
            />
          </span>
        ) : describable ? (
          <button
            type="button"
            onClick={onDescribe}
            aria-disabled={disabled || undefined}
            aria-label={`${altText ? "Edit description" : "Add description"} for ${upload.name}`}
            title={altText ?? undefined}
            className={cn(
              "self-start truncate rounded-sm text-caption font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none aria-disabled:pointer-events-none",
              altText && "text-foreground",
              TAP,
            )}
          >
            {altText ? "Edit description" : "Add description"}
          </button>
        ) : null}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Remove ${upload.name}`}
        aria-disabled={disabled || undefined}
        onClick={() => !disabled && onRemove()}
        className="size-7 shrink-0 text-muted-foreground max-lg:size-11"
      >
        <X aria-hidden="true" className="size-3.5" />
      </Button>
    </li>
  )
}

/** The files waiting in a composer, each with its progress, and "Add description" on an image the user uploaded */
export function DraftChips({
  uploads,
  onRemove,
  onDescribed,
  disabled = false,
  className,
}: {
  uploads: DraftUpload[]
  onRemove: (upload: DraftUpload) => void
  onDescribed: (key: string, altText: string | null) => void
  disabled?: boolean
  className?: string
}) {
  const [describing, setDescribing] = useState<{ key: string; id: string; altText: string | null } | null>(null)
  if (uploads.length === 0 && !describing) return null
  return (
    <>
      {uploads.length > 0 && (
        <ul aria-label="Attachments" className={cn("flex flex-wrap gap-1.5", className)}>
          {uploads.map((upload) => (
            <Chip
              key={upload.key}
              upload={upload}
              disabled={disabled}
              onRemove={() => onRemove(upload)}
              onDescribe={() =>
                upload.file && setDescribing({ key: upload.key, id: upload.file.id, altText: upload.file.alt_text ?? null })
              }
            />
          ))}
        </ul>
      )}
      <AltTextDialog
        file={describing}
        onClose={() => setDescribing(null)}
        onSaved={(saved) => describing && onDescribed(describing.key, saved.altText)}
      />
    </>
  )
}
