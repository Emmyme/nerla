import type { DocType } from "@/lib/api/files"

export type PreviewKind = "image" | "pdf" | "video" | "audio" | "text" | "none"
export type AttachmentKind = "image" | "pdf" | "video" | "audio" | "file" | DocType

const DOC_MIME: Record<string, DocType> = {
  "application/vnd.nerla.paper": "paper",
  "application/vnd.nerla.board": "board",
}

/** A paper or board, told by the type every listing and attachment carries */
export function docTypeOf(mimeType: string | null | undefined): DocType | null {
  return DOC_MIME[(mimeType ?? "").toLowerCase().split(";")[0].trim()] ?? null
}

/** Where a paper or board opens, or null for any other file */
export function docRoute(file: { id: string; mimeType: string | null | undefined }): string | null {
  const type = docTypeOf(file.mimeType)
  return type ? `/${type}/${file.id}` : null
}

const MB = 1024 * 1024

export const PREVIEW_LIMITS: Record<Exclude<PreviewKind, "none">, number> = {
  image: 20 * MB,
  pdf: 50 * MB,
  video: 200 * MB,
  audio: 200 * MB,
  text: 1 * MB,
}

/** Grid and list thumbnails load only for images up to this size */
export const THUMBNAIL_LIMIT = 5 * MB

const TEXT_TYPES = new Set(["application/json", "application/xml"])

// A file sent without a type is judged by its name
const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/** The kind of the type alone, before any size limit. SVG and HTML can carry script, so they never open */
export function typeKind(mimeType: string | null | undefined, name?: string): PreviewKind {
  let type = (mimeType ?? "").toLowerCase().split(";")[0].trim()
  if ((!type || type === "application/octet-stream") && name) type = EXTENSION_TYPES[extensionOf(name)] ?? type
  if (type.startsWith("image/")) return type === "image/svg+xml" ? "none" : "image"
  if (type === "application/pdf") return "pdf"
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  if (type.startsWith("text/") || TEXT_TYPES.has(type)) return type === "text/html" ? "none" : "text"
  return "none"
}

/** The kind a tile, glyph or chip shows, from the same rules as the preview */
export function fileKind(file: { name: string; mimeType: string | null | undefined }): AttachmentKind {
  const doc = docTypeOf(file.mimeType)
  if (doc) return doc
  const kind = typeKind(file.mimeType, file.name)
  return kind === "text" || kind === "none" ? "file" : kind
}

/** How a file opens in Nerla. Anything else, or anything over its limit, only downloads */
export function previewKind(mimeType: string | null | undefined, size: number, name?: string): PreviewKind {
  const kind = typeKind(mimeType, name)
  return kind !== "none" && size <= PREVIEW_LIMITS[kind] ? kind : "none"
}

export function hasThumbnail(file: { name: string; mimeType: string; size: number }): boolean {
  return typeKind(file.mimeType, file.name) === "image" && file.size <= THUMBNAIL_LIMIT
}

export type TypeGroup = "image" | "document" | "pdf" | "video" | "audio" | "paper" | "board" | "other"

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes) || 0)} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
