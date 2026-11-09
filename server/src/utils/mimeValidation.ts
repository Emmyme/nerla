/**
 * Browsers derive the MIME type from the file extension, so it can be spoofed.
 * A claimed type is kept only when it is on the allowlist, and where that type
 * has a known signature the file body must match it too.
 */

interface Signature {
  bytes: number[]
  offset?: number
}

const ascii = (text: string, offset = 0): Signature => ({
  bytes: [...text].map((c) => c.charCodeAt(0)),
  offset,
})

const BLOCKED_SIGNATURES: { signature: Signature; label: string }[] = [
  { signature: { bytes: [0x4d, 0x5a] }, label: "PE executable (.exe/.dll)" },
  { signature: { bytes: [0x7f, 0x45, 0x4c, 0x46] }, label: "ELF executable" },
  { signature: { bytes: [0xca, 0xfe, 0xba, 0xbe] }, label: "Java class file" },
  { signature: ascii("#!"), label: "Script (#! shebang)" },
]

const ZIP: Signature[] = [{ bytes: [0x50, 0x4b, 0x03, 0x04] }, { bytes: [0x50, 0x4b, 0x05, 0x06] }, { bytes: [0x50, 0x4b, 0x07, 0x08] }]

const OLE2: Signature[] = [{ bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }]

const ISO_BMFF: Signature[] = [ascii("ftyp", 4)]

const RIFF = (form: string): Signature[] => [ascii("RIFF"), ascii(form, 8)]

/** Body must match one of the listed signatures. */
const REQUIRED_SIGNATURES: Record<string, Signature[]> = {
  "image/jpeg": [{ bytes: [0xff, 0xd8, 0xff] }],
  "image/pjpeg": [{ bytes: [0xff, 0xd8, 0xff] }],
  "image/png": [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  "image/gif": [ascii("GIF87a"), ascii("GIF89a")],
  "image/bmp": [ascii("BM")],
  "image/avif": ISO_BMFF,
  "image/heic": ISO_BMFF,
  "image/tiff": [{ bytes: [0x49, 0x49, 0x2a, 0x00] }, { bytes: [0x4d, 0x4d, 0x00, 0x2a] }],
  "image/x-icon": [{ bytes: [0x00, 0x00, 0x01, 0x00] }],
  "image/vnd.microsoft.icon": [{ bytes: [0x00, 0x00, 0x01, 0x00] }],
  "application/pdf": [ascii("%PDF-")],
  "application/zip": ZIP,
  "application/gzip": [{ bytes: [0x1f, 0x8b] }],
  "application/x-tar": [ascii("ustar", 257)],
  "application/msword": OLE2,
  "application/vnd.ms-excel": OLE2,
  "application/vnd.ms-powerpoint": OLE2,
  "video/mp4": ISO_BMFF,
  "video/quicktime": ISO_BMFF,
  "video/webm": [{ bytes: [0x1a, 0x45, 0xdf, 0xa3] }],
  "audio/webm": [{ bytes: [0x1a, 0x45, 0xdf, 0xa3] }],
  "audio/ogg": [ascii("OggS")],
  "video/ogg": [ascii("OggS")],
  "audio/flac": [ascii("fLaC")],
  // MP3 is deliberately absent: it has no universal magic (bare frame sync with
  // optional leading padding), so a signature check would reject valid files.
}

/** Claimed types where every listed signature must match (container plus form). */
const REQUIRED_ALL_SIGNATURES: Record<string, Signature[]> = {
  "image/webp": RIFF("WEBP"),
  "audio/wav": RIFF("WAVE"),
  "audio/x-wav": RIFF("WAVE"),
  "video/x-msvideo": RIFF("AVI "),
}

/** OOXML documents are ZIP containers, matched by prefix rather than exact type. */
const ZIP_CONTAINER_PREFIX = "application/vnd.openxmlformats"

const ALLOWED_MIME_PREFIXES = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "application/msword",
  ZIP_CONTAINER_PREFIX,
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/json",
  "application/xml",
]

/** Allowed by the prefix list but able to carry script, so stored as opaque bytes. SVG is the usual one. */
const BLOCKED_MIME_TYPES = new Set(["image/svg+xml", "image/svg", "text/html", "application/xhtml+xml"])

/** Raster types with no embedded markup, so avatars can be served inline. */
const SAFE_INLINE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/pjpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
])

function normalizeMime(mime: string): string {
  return mime.toLowerCase().split(";")[0].trim()
}

export function isSafeInlineImageType(mime: string | null | undefined): boolean {
  if (!mime) return false
  return SAFE_INLINE_IMAGE_TYPES.has(normalizeMime(mime))
}

function matchesSignature(buffer: Buffer, signature: Signature): boolean {
  const offset = signature.offset ?? 0
  if (buffer.length < offset + signature.bytes.length) return false
  return signature.bytes.every((byte, i) => buffer[offset + i] === byte)
}

/** The most a signature check reads, the tar magic at 257 being the deepest */
export const MIME_HEAD_BYTES = 512

const OPAQUE = "application/octet-stream"
const MIME_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/

type MimeValidationResult = { valid: true; mimeType: string } | { valid: false; reason: string }

/**
 * Executables are refused. Everything else is stored, under its claimed type only when that type is on the
 * allowlist and the body matches its signature. Any other file is stored as opaque bytes and only ever downloads.
 */
export function validateFileMime(head: Buffer, claimedMime: string): MimeValidationResult {
  for (const { signature, label } of BLOCKED_SIGNATURES) {
    if (matchesSignature(head, signature)) {
      return { valid: false, reason: `Blocked file type: ${label}` }
    }
  }

  const normalized = normalizeMime(claimedMime)
  const opaque = { valid: true, mimeType: OPAQUE } as const

  if (normalized.length > 100 || !MIME_SHAPE.test(normalized) || BLOCKED_MIME_TYPES.has(normalized)) return opaque
  if (!ALLOWED_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return opaque

  const anyOf = normalized.startsWith(ZIP_CONTAINER_PREFIX) ? ZIP : REQUIRED_SIGNATURES[normalized]
  if (anyOf && !anyOf.some((signature) => matchesSignature(head, signature))) return opaque

  const allOf = REQUIRED_ALL_SIGNATURES[normalized]
  if (allOf && !allOf.every((signature) => matchesSignature(head, signature))) return opaque

  return { valid: true, mimeType: normalized }
}
