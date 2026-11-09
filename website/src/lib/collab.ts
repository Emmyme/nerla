import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider"
import * as Y from "yjs"
import { getToken } from "@/lib/authToken"
import { getWsBaseUrl } from "@/lib/serverUrl"

/** The web app signs in with its cookie, which the live server reads first, so the token it sends is never read */
const COOKIE_SIGNED_IN = "cookie"

export type DocProvider = { provider: HocuspocusProvider; doc: Y.Doc; destroy(): void }

/**
 * One live connection per paper or board, on a socket of its own, so closing it for one doc never touches another.
 * Desktop sends its stored JWT, a guest in a call sends a fresh doc token, and the socket comes back by itself
 * after a drop, signing in again each time.
 */
export function createDocProvider(fileId: string, opts: { shareId?: string; guestToken?: () => Promise<string> } = {}): DocProvider {
  const doc = new Y.Doc()
  const query = opts.shareId ? `?shareId=${encodeURIComponent(opts.shareId)}` : ""
  const socket = new HocuspocusProviderWebsocket({
    url: `${getWsBaseUrl()}/ws/collab${query}`,
    delay: 1000,
    factor: 2,
    maxDelay: 15000,
    maxAttempts: 0,
    jitter: true,
  })
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: `doc:${fileId}`,
    document: doc,
    token: async () => (opts.guestToken ? opts.guestToken() : ((await getToken()) ?? COOKIE_SIGNED_IN)),
  })
  provider.attach()
  return {
    provider,
    doc,
    destroy: () => {
      provider.destroy()
      socket.destroy()
      doc.destroy()
    },
  }
}
