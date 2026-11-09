import { getApiBaseUrl } from "@/lib/serverUrl"
import { ApiError, get, post, del, queryOf } from "@/lib/api/request"
import type { DocLevel, FileItem } from "@/lib/api/files"

export type ShareKind = "file" | "folder"
export type LinkExpiry = "1d" | "7d" | "30d" | "never"

export interface FileGrant {
  userId: string
  name: string
  avatarUrl: string | null
  createdAt: string
  /** Always view, except on a paper or board */
  level: DocLevel
}

/** An active outside link. `url` is left out for a workspace admin who may turn it off but not share it */
export interface FileShareLink {
  id: string
  url?: string
  expiresAt: string | null
  downloadCount: number
  createdAt: string
}

export interface StorageMember {
  userId: string
  name: string
  email: string
  avatarUrl: string | null
  used: number
  fileCount: number
  linkCount: number
}

interface StorageUsage {
  members: StorageMember[]
  total: number
  caps: { perPerson: number | null; total: number | null; maxFile: number | null }
}

/** A user's largest files by type, size and date only, and the links they made */
export interface StorageDetail {
  files: { id: string; kind: FileItem["kind"]; size: number; updatedAt: string }[]
  links: { id: string; kind: ShareKind; name: string; expiresAt: string | null; downloadCount: number }[]
}

const sharePath = (kind: ShareKind, id: string) => (kind === "file" ? `/files/${id}` : `/files/folders/${id}`)

export const fileSharingAPI = {
  grants: async (kind: ShareKind, id: string): Promise<FileGrant[]> =>
    (await get<{ grants: FileGrant[] }>(`${sharePath(kind, id)}/grants`)).grants,
  /** Sharing again with a level changes the level. Only papers and boards take one */
  share: async (kind: ShareKind, id: string, userIds: string[], level?: DocLevel): Promise<FileGrant[]> =>
    (await post<{ grants: FileGrant[] }>(`${sharePath(kind, id)}/grants`, level ? { userIds, level } : { userIds })).grants,
  unshare: (kind: ShareKind, id: string, userId: string): Promise<void> => del(`${sharePath(kind, id)}/grants/${userId}`),

  links: async (kind: ShareKind, id: string): Promise<FileShareLink[]> =>
    (await get<{ links: FileShareLink[] }>(`${sharePath(kind, id)}/links`)).links,
  createLink: (kind: ShareKind, id: string, expiry: LinkExpiry): Promise<FileShareLink> => post(`${sharePath(kind, id)}/links`, { expiry }),
  turnOffLink: (linkId: string): Promise<void> => del(`/files/links/${linkId}`),

  usage: (): Promise<StorageUsage> => get("/files/admin/usage"),
  usageOf: (userId: string): Promise<StorageDetail> => get(`/files/admin/usage/${userId}`),
  /** Permanent, for a workspace admin freeing space */
  deleteForGood: (fileId: string): Promise<void> => del(`/files/admin/files/${fileId}`),
}

export interface PublicListing {
  kind: ShareKind
  /** The file, or the folder being shown */
  name: string
  files: { id: string; name: string; size: number; mimeType: string }[]
  folders: { id: string; name: string }[]
  nextCursor: string | null
}

/** The outside link page. It sends no token or cookie, so no session logic runs */
export const publicLinksAPI = {
  view: async (
    token: string,
    query: { folderId?: string | null; cursor?: string | null },
    signal?: AbortSignal,
  ): Promise<PublicListing> => {
    const search = queryOf(query)
    const res = await fetch(`${getApiBaseUrl()}/public/links/${encodeURIComponent(token)}${search ? `?${search}` : ""}`, {
      credentials: "omit",
      signal,
    })
    if (!res.ok) throw new ApiError(res.status, {})
    return (await res.json()) as PublicListing
  },
  downloadUrl: (token: string, fileId: string): string =>
    `${getApiBaseUrl()}/public/links/${encodeURIComponent(token)}/files/${encodeURIComponent(fileId)}/download`,
}
