/** Live updates by topic: `user:<id>`, `org:<id>` and `held:<id>` */
type Live = {
  publish(topic: string, payload: unknown): void
  subscribe(topic: string, handler: (payload: unknown) => void): () => void
  close(): Promise<void>
}

/** shortcut: one process only, a second server process needs a shared backend behind the same interface */
export function memoryLive(): Live {
  const topics = new Map<string, Set<(payload: unknown) => void>>()
  return {
    publish(topic, payload) {
      for (const handler of [...(topics.get(topic) ?? [])]) handler(payload)
    },
    subscribe(topic, handler) {
      const handlers = topics.get(topic) ?? new Set()
      topics.set(topic, handlers)
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
        if (handlers.size === 0 && topics.get(topic) === handlers) topics.delete(topic)
      }
    },
    async close() {
      topics.clear()
    },
  }
}

export const live: Live = memoryLive()
