import { useEffect, useState } from "react"
import { ApiError } from "@/lib/api/request"
import { usersAPI, type UserProfile } from "@/lib/api/users"

type ProfileState = { status: "loading" } | { status: "ready"; profile: UserProfile } | { status: "missing" } | { status: "error" }

type Settled = Exclude<ProfileState, { status: "loading" }>

// Cards are kept for 10 minutes, per viewer. Only a loaded card is kept, so the next open asks again after a miss or a failure
const TTL = 10 * 60_000
const known = new Map<string, { entry: Settled; at: number }>()
const pending = new Map<string, Promise<Settled>>()

/** Drops every viewer's kept card of a user, such as after they edit their own profile */
export function forgetProfile(userId: string) {
  const suffix = `:${userId.toLowerCase()}`
  for (const key of known.keys()) if (key.endsWith(suffix)) known.delete(key)
}

export function loadProfile(viewer: string, userId: string): Promise<Settled> {
  const key = `${viewer.toLowerCase()}:${userId.toLowerCase()}`
  const hit = known.get(key)
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.entry)
  if (hit) known.delete(key)
  let request = pending.get(key)
  if (!request) {
    request = usersAPI
      .getUser(userId.toLowerCase())
      .then<Settled, Settled>(
        (profile) => ({ status: "ready", profile }),
        (err) => (err instanceof ApiError && err.status === 404 ? { status: "missing" } : { status: "error" }),
      )
      .then((entry) => {
        pending.delete(key)
        if (entry.status === "ready") known.set(key, { entry, at: Date.now() })
        return entry
      })
    pending.set(key, request)
  }
  return request
}

export function useProfile(viewer: string, userId: string | null, attempt = 0): ProfileState {
  const [state, setState] = useState<{ key: string; value: Settled } | null>(null)
  const key = userId ? `${viewer}:${userId}:${attempt}`.toLowerCase() : ""
  useEffect(() => {
    if (!userId || !viewer) return
    let live = true
    void loadProfile(viewer, userId).then((value) => {
      if (live) setState({ key, value })
    })
    return () => {
      live = false
    }
  }, [viewer, userId, key])
  if (!userId) return { status: "missing" }
  return state?.key === key ? state.value : { status: "loading" }
}
