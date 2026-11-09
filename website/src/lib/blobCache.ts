import { filesAPI } from "@/lib/api/files"

// Preview downloads stay for the session, so stepping between tasks never fetches a file twice.
// Files nobody shows are dropped oldest first once the cache passes either limit.
const MAX_FILES = 24
const MAX_BYTES = 48 * 1024 * 1024
// Thumbnails, tiles and chips download a few at a time, so a big grid never floods the server
const LANES = 4

type Entry = {
  users: number
  size: number
  url: string | null
  load: Promise<string>
  controller: AbortController
  /** Set while the download waits for a lane */
  start: (() => void) | null
}

export type BlobLease = { url: Promise<string>; release: () => void }

const entries = new Map<string, Entry>()
const waiting: Entry[] = []
let running = 0

export function cachedBlobUrl(id: string): string | null {
  return entries.get(id)?.url ?? null
}

/**
 * The file's blob URL, through the shared queue. A preview the user opened goes first and never waits for a
 * lane, the rest queue behind it.
 */
export function leaseBlobUrl(id: string, { urgent = false }: { urgent?: boolean } = {}): BlobLease {
  const entry = entries.get(id) ?? download(id)
  entries.delete(id)
  entries.set(id, entry)
  entry.users += 1
  if (urgent && entry.start) {
    waiting.splice(waiting.indexOf(entry), 1)
    entry.start()
  }
  pump()

  let released = false
  return {
    url: entry.load,
    release: () => {
      if (released) return
      released = true
      entry.users -= 1
      if (entry.users > 0) return
      if (!entry.url) {
        if (entry.start) waiting.splice(waiting.indexOf(entry), 1)
        entry.controller.abort()
        if (entries.get(id) === entry) entries.delete(id)
      }
      // Later, so a preview mounting in the same render can take the file before it is dropped
      queueMicrotask(trim)
    },
  }
}

function download(id: string): Entry {
  const controller = new AbortController()
  let settle: { resolve: (url: string) => void; reject: (err: unknown) => void } = { resolve: () => {}, reject: () => {} }
  const entry: Entry = {
    users: 0,
    size: 0,
    url: null,
    load: new Promise<string>((resolve, reject) => {
      settle = { resolve, reject }
    }),
    controller,
    start: null,
  }
  // A lease that only waited may be cancelled with nobody listening
  entry.load.catch(() => {})
  controller.signal.addEventListener("abort", () => entry.start && settle.reject(new DOMException("Cancelled", "AbortError")), {
    once: true,
  })
  entry.start = () => {
    entry.start = null
    running += 1
    filesAPI
      .downloadFile(id, controller.signal)
      .then(
        (blob) => {
          entry.url = URL.createObjectURL(blob)
          entry.size = blob.size
          trim()
          settle.resolve(entry.url)
        },
        (err: unknown) => {
          if (entries.get(id) === entry) entries.delete(id)
          settle.reject(err)
        },
      )
      .finally(() => {
        running -= 1
        pump()
      })
  }
  waiting.push(entry)
  return entry
}

function pump() {
  while (running < LANES && waiting.length > 0) waiting.shift()?.start?.()
}

function trim() {
  let bytes = 0
  for (const entry of entries.values()) bytes += entry.size
  for (const [id, entry] of entries) {
    if (entries.size <= MAX_FILES && bytes <= MAX_BYTES) return
    if (entry.users > 0 || !entry.url) continue
    URL.revokeObjectURL(entry.url)
    bytes -= entry.size
    entries.delete(id)
  }
}
