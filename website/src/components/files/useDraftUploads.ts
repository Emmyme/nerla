import { useEffect, useRef, useState } from "react"
import { fileBrowserAPI, filesAPI, type FileItem, type TaskAttachment } from "@/lib/api/files"
import { PREVIEW_LIMITS, typeKind } from "./fileKinds"
import { batchLimit, overLimit, uploadFailure } from "./uploadErrors"

/** One chip in a composer: a file on its way up, an uploaded draft, or a file picked from Nerla */
export type DraftUpload = {
  key: string
  name: string
  size: number
  mimeType: string | null
  progress: number
  file: TaskAttachment | null
  error: string | null
  abort: AbortController
  /** A local preview for images, freed when the chip leaves the composer */
  preview: string | null
  /** Uploaded from this composer, so removing the chip deletes the file */
  draft: boolean
  /** Only the uploader may describe an image */
  canDescribe: boolean
}

/** Files a post sent that the server did not link, such as one that went to Trash meanwhile */
export function skippedFiles(sent: string[], linked: { id: string }[]): number {
  const kept = new Set(linked.map((file) => file.id))
  return sent.filter((id) => !kept.has(id)).length
}

export const skippedText = (count: number) => `${count} ${count === 1 ? "file" : "files"} couldn't be attached`

const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/** Drafts whose post or attach is running, which no removal or unmount may delete */
type Held = Set<string>

function discard(upload: DraftUpload, held: Held) {
  upload.abort.abort()
  if (upload.preview) URL.revokeObjectURL(upload.preview)
  // A draft nobody removes goes with the daily cleanup, so a failed delete needs no retry here
  if (upload.draft && upload.file && !held.has(upload.file.id)) fileBrowserAPI.purgeFile(upload.file.id).catch(() => {})
}

/** The chips a composer sends with its text. Uploads start at once as drafts, and sending posts the ready ones */
export function useDraftUploads() {
  const [uploads, setUploads] = useState<DraftUpload[]>([])
  const live = useRef(uploads)
  live.current = uploads
  const held = useRef<Held>(new Set())

  // Leaving with chips unsent cancels what is running and deletes what was uploaded, unless it is being posted
  useEffect(() => () => live.current.forEach((upload) => discard(upload, held.current)), [])

  const patch = (key: string, change: Partial<DraftUpload>) =>
    setUploads((list) => list.map((upload) => (upload.key === key ? { ...upload, ...change } : upload)))

  const addFiles = (files: File[]) => {
    // One organization read for the whole batch tells which files are over the workspace's limit
    const limit = batchLimit()
    const batch = files.map<DraftUpload>((file) => ({
      key: newKey(),
      name: file.name,
      size: file.size,
      mimeType: file.type || null,
      progress: 0,
      file: null,
      error: null,
      abort: new AbortController(),
      preview: typeKind(file.type, file.name) === "image" && file.size <= PREVIEW_LIMITS.image ? URL.createObjectURL(file) : null,
      draft: true,
      canDescribe: true,
    }))
    setUploads((list) => [...list, ...batch])
    void limit().then((max) => {
      for (const [index, file] of files.entries()) {
        const upload = batch[index]
        if (upload.abort.signal.aborted) continue
        if (max && file.size > max) {
          patch(upload.key, { error: overLimit(max) })
          continue
        }
        void filesAPI
          .uploadFile(file, {
            purpose: "draft",
            onProgress: (fraction) => patch(upload.key, { progress: fraction }),
            signal: upload.abort.signal,
          })
          .then((saved) => {
            const posted: TaskAttachment = {
              id: saved.id,
              file_name: saved.fileName,
              file_size: saved.fileSize,
              mime_type: saved.mimeType ?? null,
              created_at: saved.createdAt,
              alt_text: null,
            }
            // Removed while the last bytes went up, so the draft goes now
            if (upload.abort.signal.aborted) return void fileBrowserAPI.purgeFile(saved.id).catch(() => {})
            patch(upload.key, { progress: 1, file: posted })
          })
          .catch(async (err: unknown) => {
            if (upload.abort.signal.aborted) return
            const message = await uploadFailure(err, file, limit)
            patch(upload.key, { error: message })
          })
      }
    })
  }

  const addPicked = (items: FileItem[]) =>
    setUploads((list) => {
      const shown = new Set(list.flatMap((upload) => (upload.file ? [upload.file.id] : [])))
      const fresh = items
        .filter((item) => !shown.has(item.id))
        .map<DraftUpload>((item) => ({
          key: newKey(),
          name: item.name,
          size: item.size,
          mimeType: item.mimeType,
          progress: 1,
          file: {
            id: item.id,
            file_name: item.name,
            file_size: item.size,
            mime_type: item.mimeType,
            created_at: new Date().toISOString(),
            alt_text: item.altText,
            uploaded_by: item.owner.id,
          },
          error: null,
          abort: new AbortController(),
          preview: null,
          draft: false,
          canDescribe: item.can.includes("editAlt"),
        }))
      return [...list, ...fresh]
    })

  const remove = (upload: DraftUpload) => {
    discard(upload, held.current)
    setUploads((list) => list.filter((u) => u.key !== upload.key))
  }

  const describe = (key: string, altText: string | null) =>
    setUploads((list) =>
      list.map((upload) => (upload.key === key && upload.file ? { ...upload, file: { ...upload.file, alt_text: altText } } : upload)),
    )

  /** A chip whose file is posted now leaves without deleting it */
  const drop = (upload: DraftUpload) => {
    if (upload.preview) URL.revokeObjectURL(upload.preview)
    live.current = live.current.filter((u) => u.key !== upload.key)
    setUploads((list) => list.filter((u) => u.key !== upload.key))
  }

  const fail = (key: string, error: string) => patch(key, { error })

  /** Marks files as on their way into a post. The returned release lets them be deleted again after a failure */
  const hold = (ids: string[]) => {
    ids.forEach((id) => held.current.add(id))
    return () => ids.forEach((id) => held.current.delete(id))
  }

  /** After a send, the files are posted, so only the local previews go, and nothing is deleted */
  const clear = () => {
    live.current.forEach((upload) => upload.preview && URL.revokeObjectURL(upload.preview))
    live.current = []
    setUploads([])
  }

  const uploading = uploads.some((u) => !u.file && !u.error)
  const ready = uploads.flatMap((u) => (u.file ? [u.file] : []))
  return { uploads, addFiles, addPicked, remove, drop, fail, describe, hold, clear, uploading, ready }
}
