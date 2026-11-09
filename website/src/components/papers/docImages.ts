import { papersAPI, type DocAccess } from "@/lib/api/papers"

/** Images in papers and boards stay for the session up to this many, the one used longest ago dropped first */
const MAX_IMAGES = 100

/** `users` counts the mounted images showing the entry's object URL, which is never revoked while any are */
type Entry = { blob: Promise<Blob>; url: string | null; users: number }

export type DocImageLease = { url: Promise<string>; release: () => void }

const entries = new Map<string, Entry>()

/** Drops the entries used longest ago that nothing shows, until the cache fits */
function trim() {
  for (const [key, entry] of entries) {
    if (entries.size <= MAX_IMAGES) return
    if (entry.users > 0) continue
    if (entry.url) URL.revokeObjectURL(entry.url)
    entries.delete(key)
  }
}

function entryFor(fileId: string, docId: string, access: DocAccess): Entry {
  const key = `${docId}:${fileId}`
  const known = entries.get(key)
  if (known) {
    entries.delete(key)
    entries.set(key, known)
    return known
  }
  const entry: Entry = { blob: papersAPI.image(fileId, docId, access), url: null, users: 0 }
  entry.blob.catch(() => {
    if (entries.get(key) === entry) entries.delete(key)
  })
  entries.set(key, entry)
  return entry
}

/**
 * The bytes of an image inside the doc, downloaded once while it stays cached. A board turns them into its own data
 * URL, so it holds no object URL and needs no lease
 */
export function docImageBlob(fileId: string, docId: string, access: DocAccess): Promise<Blob> {
  const { blob } = entryFor(fileId, docId, access)
  trim()
  return blob
}

/**
 * An object URL for an image inside the doc, held until `release`. The URL is revoked only once nothing shows it and
 * the image has left the cache
 */
export function leaseDocImage(fileId: string, docId: string, access: DocAccess): DocImageLease {
  const key = `${docId}:${fileId}`
  const entry = entryFor(fileId, docId, access)
  entry.users += 1
  trim()
  let released = false
  return {
    // A lease released before the download finished makes no URL, so none is left behind unrevoked
    url: entry.blob.then((blob) => (released ? "" : (entry.url ??= URL.createObjectURL(blob)))),
    release: () => {
      if (released) return
      released = true
      entry.users -= 1
      if (entry.users > 0) return
      // Deferred, so an image mounting again in the same render keeps the URL
      queueMicrotask(() => {
        if (entry.users > 0) return
        if (entries.get(key) !== entry) {
          if (entry.url) URL.revokeObjectURL(entry.url)
          entry.url = null
        } else trim()
      })
    },
  }
}
