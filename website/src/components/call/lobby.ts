export type LobbyEntry = { sessionId: string; guestName: string }

export type LobbyEvent =
  | { type: "request"; entry: LobbyEntry }
  | { type: "resolved"; sessionId: string }
  /** `newer` holds requests that arrived live after the replay was asked for. Anything older that it leaves out is gone. */
  | { type: "replay"; entries: LobbyEntry[]; newer?: ReadonlySet<string> }

/** Guests waiting to join, oldest first, one entry per session. Unchanged input comes back as the same array. */
export function mergeLobby(current: LobbyEntry[], event: LobbyEvent): LobbyEntry[] {
  switch (event.type) {
    case "request":
      return current.some((e) => e.sessionId === event.entry.sessionId) ? current : [...current, event.entry]
    case "resolved":
      return current.some((e) => e.sessionId === event.sessionId) ? current.filter((e) => e.sessionId !== event.sessionId) : current
    case "replay": {
      // The replay lists who was waiting when it was read, so it goes ahead of anything that arrived live since
      const replayed = new Set(event.entries.map((e) => e.sessionId))
      const fresh = event.entries.filter((e, i) => event.entries.findIndex((o) => o.sessionId === e.sessionId) === i)
      const live = current.filter((e) => !replayed.has(e.sessionId) && event.newer?.has(e.sessionId))
      const merged = [...fresh, ...live]
      const same = merged.length === current.length && merged.every((e, i) => e.sessionId === current[i].sessionId)
      return same ? current : merged
    }
  }
}
