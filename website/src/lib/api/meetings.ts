import { getApiBaseUrl } from "@/lib/serverUrl"
import { request, get, post } from "@/lib/api/request"

export const meetingsAPI = {
  getToken: async (roomName: string): Promise<{ token: string; livekitUrl: string | null; title: string }> => {
    return post("/meetings/token", { roomName })
  },

  /** Guests still waiting in the room's lobby, oldest first. Hosts only. */
  lobby: async (roomName: string): Promise<{ sessionId: string; guestName: string }[]> => {
    return get(`/meetings/lobby?roomName=${encodeURIComponent(roomName)}`)
  },

  /** Who is already in the call, for a member's pre-join. Guests never ask */
  presence: async (roomName: string): Promise<{ people: { userId: string; name: string }[]; guests: number }> => {
    return get(`/meetings/presence?roomName=${encodeURIComponent(roomName)}`)
  },

  /** Meet now: a fresh room with the caller in it, and a guest link to share */
  instant: async (): Promise<{ roomName: string; joinUrl: string }> => {
    return post("/meetings/instant")
  },

  invite: async (roomName: string, targetUserId: string): Promise<{ message: string }> => {
    return post("/meetings/invite", { roomName, targetUserId })
  },

  /** A guest gives only a name. The secret is the guest's alone, hosts only ever see the session id */
  guestRequest: async (roomName: string, name: string): Promise<{ sessionId: string; secret: string }> => {
    return post("/meetings/guest-request", { roomName, name })
  },

  guestStatus: async (
    sessionId: string,
    secret: string,
  ): Promise<{ status: string; token?: string; livekitUrl?: string | null; pass?: string; passExpiresAt?: string }> => {
    return request(`/meetings/guest-status/${encodeURIComponent(sessionId)}`, {
      method: "GET",
      headers: { "X-Guest-Secret": secret },
    })
  },

  /** A fresh call pass while the guest is still in the call. The pass proves the guest to Nerla, never to LiveKit */
  guestPassRefresh: (pass: string): Promise<{ pass: string; passExpiresAt: string }> =>
    request("/meetings/guest-pass/refresh", { method: "POST", headers: { Authorization: `Bearer ${pass}` } }),

  /** The guest stopped waiting, so the hosts' lobby drops the request */
  guestCancel: async (sessionId: string, secret: string): Promise<{ message: string }> => {
    return post("/meetings/guest-cancel", { sessionId, secret })
  },

  /** A best effort cancel for a guest tab that is closing, when a normal request may not finish */
  guestCancelOnExit: (sessionId: string, secret: string): void => {
    const url = `${getApiBaseUrl()}/meetings/guest-cancel`
    const body = JSON.stringify({ sessionId, secret })
    try {
      if (navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return
    } catch {
      // Some browsers refuse a JSON beacon to another origin, a keepalive fetch still goes out
    }
    void fetch(url, { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => {})
  },

  admitGuest: async (sessionId: string, roomName: string): Promise<{ message: string }> => {
    return post("/meetings/guest-admit", { sessionId, roomName })
  },

  denyGuest: async (sessionId: string, roomName: string): Promise<{ message: string }> => {
    return post("/meetings/guest-deny", { sessionId, roomName })
  },
}
