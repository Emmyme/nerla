import { isTauri } from "@tauri-apps/api/core"
import type { Store } from "@tauri-apps/plugin-store"

/** Tauri plugin-store file (app data dir, not webview localStorage). */
const STORE_FILE = "nerla.bin"
const AUTH_KEY = "auth_token"
const KNOWN_KEY = "known_marks"

let storePromise: Promise<Store> | null = null

/** The desktop app's plugin store, shared with serverUrl. Null outside the desktop app or when it fails to load */
export async function getStore(): Promise<Store | null> {
  if (!isTauri()) return null
  if (!storePromise) {
    const { load } = await import("@tauri-apps/plugin-store")
    storePromise = load(STORE_FILE, { autoSave: true, defaults: {} })
  }
  try {
    return await storePromise
  } catch (err) {
    console.error("[authToken] Tauri store failed to load", err)
    storePromise = null
    return null
  }
}

/** The desktop app's session token. Null on the web, which signs in with an httpOnly cookie */
export async function getToken(): Promise<string | null> {
  return (await (await getStore())?.get<string>(AUTH_KEY)) ?? null
}

export async function setToken(token: string): Promise<void> {
  const store = await getStore()
  if (!store) return
  await store.set(AUTH_KEY, token)
  await store.save()
}

/** The marks the server gave for accounts signed in here, so strangers guessing can't keep this app out. Signing out keeps them */
export async function getKnownMarks(): Promise<string | null> {
  return (await (await getStore())?.get<string>(KNOWN_KEY)) ?? null
}

export async function setKnownMarks(marks: string): Promise<void> {
  const store = await getStore()
  if (!store) return
  await store.set(KNOWN_KEY, marks)
  await store.save()
}

export async function removeToken(): Promise<void> {
  const store = await getStore()
  if (!store) return
  await store.delete(AUTH_KEY)
  await store.save()
}
