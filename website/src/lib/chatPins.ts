import { chatsAPI, type ChatMessage } from "@/lib/api/chat"
import { messageOf } from "@/lib/taskStore"
import { type PinsState, store, pinsLoading, pinChanges, publish } from "@/lib/chatStore"
import { parseKey } from "@/lib/chatModel"
import { notDeleted } from "@/lib/chatLoad"

const PINS_FAILED = "Couldn't load the pinned messages. Check your connection and try again."

export function setPins(key: string, update: (entry: PinsState) => PinsState) {
  const current = store.pins[key] ?? { messages: [], loaded: false, status: "loading", error: null, stale: false }
  store.pins = { ...store.pins, [key]: update(current) }
  publish()
}

// A loaded list follows every change, and one it cannot place loads again
export function updatePins(key: string, update: (list: ChatMessage[]) => ChatMessage[] | null) {
  pinChanges.set(key, (pinChanges.get(key) ?? 0) + 1)
  const entry = store.pins[key]
  if (!entry?.loaded) return
  const next = update(entry.messages)
  if (next === entry.messages) return
  setPins(key, (p) => (next ? { ...p, messages: next } : { ...p, stale: true }))
}

export async function loadPins(key: string): Promise<void> {
  if (pinsLoading.has(key)) return
  pinsLoading.add(key)
  const at = store.generation
  const since = pinChanges.get(key) ?? 0
  setPins(key, (p) => ({ ...p, status: p.loaded ? "ready" : "loading", error: null }))
  const [kind, id] = parseKey(key)
  try {
    const list = (await chatsAPI.pins(kind, id)).filter(notDeleted)
    if (at !== store.generation) return
    pinsLoading.delete(key)
    // A pin that changed while the list was out leaves it stale, so it loads again
    const stale = (pinChanges.get(key) ?? 0) !== since
    setPins(key, () => ({ messages: list, loaded: true, status: "ready", error: null, stale }))
  } catch (err) {
    if (at !== store.generation) return
    pinsLoading.delete(key)
    setPins(key, (p) => ({ ...p, status: p.loaded ? "ready" : "error", error: messageOf(err, PINS_FAILED) }))
  }
}
