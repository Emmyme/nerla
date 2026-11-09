import { request, get, post, patch, del } from "@/lib/api/request"
import type { DocType, DocLevel, FileItem } from "@/lib/api/files"
import type { Via } from "@/lib/api/ai"

export interface DocMeta {
  file: FileItem
  docType: DocType
  level: DocLevel
  canComment: boolean
}

export interface DocPerson {
  id: string
  name: string
  avatarUrl: string | null
}

export interface DocVersion {
  id: string
  createdAt: string
  /** Empty for a restore point the server saved */
  editors: { id: string; name: string }[]
  /** Made through the user's agent or AI */
  done_via?: Via | null
  /** The first version of a paper or board the AI or an agent made */
  created?: boolean
}

/** `from` and `to` are encoded Yjs relative positions. A board pin has no `boardId` on a board file */
export type CommentAnchor =
  { type: "text"; from: string; to: string; quote: string } | { type: "board"; boardId: string | null; x: number; y: number }

export interface CommentDto {
  id: string
  parentId: string | null
  /** Null once deleted, or when the author's account is gone */
  author: { id: string; name: string; avatarUrl: string | null } | { guestName: string } | null
  body: string
  anchor: CommentAnchor | null
  createdAt: string
  updatedAt: string
  deleted: boolean
  mine: boolean
  /** Made through the user's agent or AI */
  done_via?: Via | null
}

export interface CommentThread {
  root: CommentDto
  replies: CommentDto[]
}

export interface CallShare {
  id: string
  fileId: string
  docType: DocType
  name: string
  level: DocLevel
  /** Guests get the name alone */
  openedBy: { id?: string; name: string }
}

type CallShareCreate = { roomName: string; level: DocLevel } & (
  { fileId: string } | { create: { docType: DocType; template: "blank" | "meeting" } }
)

/** How a doc's routes know who asks: a call share for members, a doc token for guests */
export type DocAccess = { shareId?: string | null; docToken?: string | null }

const shareQuery = (shareId?: string | null) => (shareId ? `?shareId=${encodeURIComponent(shareId)}` : "")
const docHeaders = (access: DocAccess): Record<string, string> => (access.docToken ? { "X-Doc-Token": access.docToken } : {})

const peopleReads = new Map<string, Promise<DocPerson[]>>()

export const papersAPI = {
  create: (body: { docType: DocType; name?: string; folderId?: string | null; projectId?: string | null }): Promise<FileItem> =>
    post("/papers", body),
  get: (id: string, shareId?: string | null, signal?: AbortSignal): Promise<DocMeta> =>
    get(`/papers/${id}${shareQuery(shareId)}`, { signal }),
  /** Callers who ask at the same moment share one request */
  people: (id: string, shareId?: string | null): Promise<DocPerson[]> => {
    const key = `${id}:${shareId ?? ""}`
    let read = peopleReads.get(key)
    if (!read) {
      read = get<{ people: DocPerson[] }>(`/papers/${id}/people${shareQuery(shareId)}`)
        .then((found) => found.people)
        .finally(() => peopleReads.delete(key))
      peopleReads.set(key, read)
    }
    return read
  },

  versions: (id: string, shareId?: string | null): Promise<DocVersion[]> => get(`/papers/${id}/versions${shareQuery(shareId)}`),
  /** The version's Yjs state, base64 */
  version: (id: string, versionId: string, shareId?: string | null): Promise<{ state: string }> =>
    get(`/papers/${id}/versions/${versionId}${shareQuery(shareId)}`),
  restore: (id: string, versionId: string, shareId?: string | null): Promise<void> =>
    post(`/papers/${id}/versions/${versionId}/restore${shareQuery(shareId)}`),

  comments: async (id: string, access: DocAccess = {}): Promise<CommentThread[]> =>
    (
      await request<{ threads: CommentThread[] }>(`/papers/${id}/comments${shareQuery(access.shareId)}`, {
        method: "GET",
        headers: docHeaders(access),
      })
    ).threads,
  addComment: (
    id: string,
    body: { body: string; anchor?: CommentAnchor; parentId?: string },
    access: DocAccess = {},
  ): Promise<CommentDto> =>
    request(`/papers/${id}/comments${shareQuery(access.shareId)}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: docHeaders(access),
    }),
  editComment: (commentId: string, body: string, shareId?: string | null): Promise<CommentDto> =>
    patch(`/papers/comments/${commentId}${shareQuery(shareId)}`, { body }),
  deleteComment: (commentId: string, shareId?: string | null): Promise<void> => del(`/papers/comments/${commentId}${shareQuery(shareId)}`),
  /** Hides a whole thread for the user only */
  hideThread: (commentId: string, shareId?: string | null): Promise<void> =>
    post(`/papers/comments/${commentId}/hide${shareQuery(shareId)}`),

  /** A member in the call, or a guest with their call pass as `bearer` */
  callShares: async (roomName: string, bearer?: string): Promise<CallShare[]> =>
    (
      await request<{ shares: CallShare[] }>(`/papers/call-shares?roomName=${encodeURIComponent(roomName)}`, {
        method: "GET",
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      })
    ).shares,
  openCallShare: (body: CallShareCreate): Promise<{ share: CallShare; file: FileItem }> => post("/papers/call-shares", body),
  closeCallShare: (shareId: string): Promise<void> => del(`/papers/call-shares/${shareId}`),
  /** A guest's 10 minute doc token for one open share, proved with their call pass */
  guestToken: (shareId: string, bearer: string): Promise<{ token: string; expiresAt: string; fileId: string; level: DocLevel }> =>
    request("/papers/guest-token", {
      method: "POST",
      body: JSON.stringify({ shareId }),
      headers: { Authorization: `Bearer ${bearer}` },
    }),
  /**
   * Papers and boards made or shown in this occurrence's calls. The server reads a start's day in the event's own
   * zone, and an all-day occurrence names its day as it is, YYYY-MM-DD
   */
  forEvent: (eventId: string, when: { start: Date } | { date: string }): Promise<FileItem[]> =>
    get(
      `/papers/for-event/${eventId}?${"start" in when ? `start=${encodeURIComponent(when.start.toISOString())}` : `date=${encodeURIComponent(when.date)}`}`,
    ),

  thumbnail: (id: string, shareId?: string | null): Promise<Blob> =>
    get(`/papers/${id}/thumbnail${shareQuery(shareId)}`, { responseType: "blob" }),
  saveThumbnail: (id: string, png: Blob): Promise<void> =>
    request(`/papers/${id}/thumbnail`, { method: "PUT", body: png, headers: { "Content-Type": "image/png" } }),

  /**
   * An image inside a paper or board, through the call share or the guest's doc token when that is how the doc opened.
   * The server answers only when the file is an image of `docId`, so a doc never shows a file it doesn't hold
   */
  image: (fileId: string, docId: string, access: DocAccess = {}, signal?: AbortSignal): Promise<Blob> =>
    request(`/files/${fileId}/download?${new URLSearchParams({ doc: docId, ...(access.shareId ? { share: access.shareId } : {}) })}`, {
      method: "GET",
      responseType: "blob",
      signal,
      timeoutMs: 120000,
      headers: docHeaders(access),
    }),
}
