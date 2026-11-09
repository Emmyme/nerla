import { useEffect, useState } from "react"
import { avatarAPI } from "@/lib/api/users"

type Entry = { users: number; url: string | null; load: Promise<string> }

// One blob per avatar URL, shared by every view showing it and revoked when the last one lets go
const entries = new Map<string, Entry>()

function lease(avatarUrl: string): { url: string | null; load: Promise<string>; release: () => void } {
  let entry = entries.get(avatarUrl)
  if (!entry) {
    const created: Entry = { users: 0, url: null, load: Promise.resolve("") }
    created.load = avatarAPI.getAvatar(avatarUrl).then(
      (blob) => {
        const url = URL.createObjectURL(blob)
        if (entries.get(avatarUrl) === created) created.url = url
        else URL.revokeObjectURL(url)
        return url
      },
      (err: unknown) => {
        if (entries.get(avatarUrl) === created) entries.delete(avatarUrl)
        throw err
      },
    )
    entries.set(avatarUrl, created)
    entry = created
  }
  const held = entry
  held.users += 1
  let released = false
  return {
    url: held.url,
    load: held.load,
    release: () => {
      if (released) return
      released = true
      held.users -= 1
      // Later, so a remount in the same render takes the blob over instead of fetching it again
      queueMicrotask(() => {
        if (held.users > 0) return
        if (entries.get(avatarUrl) === held) entries.delete(avatarUrl)
        if (held.url) URL.revokeObjectURL(held.url)
      })
    },
  }
}

/** An avatar as a blob URL, fetched with the user's credentials so it also loads in the desktop app */
export function useAvatarSrc(avatarUrl: string | null | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    if (!avatarUrl) {
      setSrc(null)
      return
    }
    let live = true
    const held = lease(avatarUrl)
    setSrc(held.url)
    held.load.then(
      (url) => live && setSrc(url),
      () => live && setSrc(null),
    )
    return () => {
      live = false
      held.release()
    }
  }, [avatarUrl])

  return src
}
