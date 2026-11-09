/** Untrusted filenames, used in storage keys and response headers. */

/** Anything that is not a short alphanumeric extension collapses to "bin". */
export function safeExtension(filename: string): string {
  const raw = filename.split(".").pop() ?? ""
  return /^[a-z0-9]{1,10}$/i.test(raw) ? raw.toLowerCase() : "bin"
}

/**
 * Content-Disposition that cannot inject extra headers: the ASCII fallback drops
 * control characters and quotes, and filename* carries the real UTF-8 name.
 */
export function attachmentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
