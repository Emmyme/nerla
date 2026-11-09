import { isTauri } from "@tauri-apps/api/core"
import { getToken } from "@/lib/authToken"
import { getApiBaseUrl } from "@/lib/serverUrl"
import type { SymbolKey } from "@/components/ui/symbols"
import type { FolderColor } from "@/lib/folderColors"
import {
  ApiError,
  clientHeaders,
  noticeReadOnly,
  handleUnauthorized,
  TRANSFER_TIMEOUT_MS,
  request,
  get,
  post,
  patch,
  del,
  queryOf,
} from "@/lib/api/request"
import type { ChatMessage } from "@/lib/api/chat"
import type { Via } from "@/lib/api/ai"

interface FileAttachment {
  id: string
  fileName: string
  fileSize: number
  mimeType?: string
  createdAt: string
}

/** A file as posted on a message, task or comment. `created_at` is when it was posted there */
export interface TaskAttachment {
  id: string
  file_name: string
  file_size: number
  mime_type: string | null
  created_at: string
  alt_text?: string | null
  removed?: false
  /** The day a removed member's file goes */
  removal_deadline?: string | null
  uploaded_by?: string | null
}

/** A posted file its owner moved to Trash, or one past its removed owner's deadline */
export interface RemovedAttachment {
  id: string
  removed: true
}

export type Attachment = TaskAttachment | RemovedAttachment

export const isRemoved = (attachment: Attachment): attachment is RemovedAttachment => attachment.removed === true

type UploadOptions = {
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** No purpose makes a draft, which a post later claims. `doc` is an image inside the paper or board `docId` */
  purpose?: "avatar" | "draft" | "file" | "doc"
  projectId?: string | null
  folderId?: string | null
  docId?: string
  /** The call share the doc is open through */
  shareId?: string
}

export type FileAction = "view" | "rename" | "move" | "trash" | "restore" | "purge" | "share" | "link" | "copy" | "attach" | "editAlt"

export type FileSection = "mine" | "shared" | "recent" | "project"
export type DocType = "paper" | "board"
/** What a user may do with a paper or board. Other files are only ever view */
export type DocLevel = "view" | "comment" | "edit"
export type FileSort = "name" | "updated" | "size"

/** A file as the Files API lists it. `can` holds every action the viewer may take, so the page checks nothing itself */
export interface FileItem {
  id: string
  name: string
  size: number
  mimeType: string
  kind: "image" | "pdf" | "video" | "audio" | "file"
  /** Set for a paper or board, which opens on its own page */
  docType: DocType | null
  altText: string | null
  owner: { id: string; name: string; avatarUrl: string | null }
  projectId: string | null
  folderId: string | null
  updatedAt: string
  deletedAt: string | null
  /** The end of Trash, or the day a removed member's file goes */
  removalDeadline: string | null
  /** Where a file the viewer does not own reached them */
  context: { by: string; where: string; href: string } | null
  can: FileAction[]
  /** Set when the owner's AI or agent created it */
  done_via?: Via | null
}

export interface FolderItem {
  id: string
  name: string
  color: FolderColor | null
  icon?: string | null
  parentId: string | null
  projectId: string | null
  updatedAt: string
  can: FileAction[]
  /** Browse only: the bytes of what the viewer can see below it, and how many items it holds */
  size?: number
  itemCount?: number
}

export interface FileListing {
  folders: FolderItem[]
  files: FileItem[]
  usage: { used: number; cap: number | null }
  nextCursor: string | null
  /** From the section's first reachable folder down to the open one. Browse only */
  trail?: { id: string; name: string; color?: FolderColor | null }[]
}

type FileBrowseQuery = {
  section: FileSection
  projectId?: string | null
  folderId?: string | null
  sort?: FileSort
  dir?: "asc" | "desc"
  cursor?: string | null
}

export type FileSearchQuery = {
  /** Empty when a filter is set */
  q?: string
  projectId?: string
  folderId?: string
  type?: "image" | "document" | "pdf" | "video" | "audio" | "paper" | "board" | "other"
  owner?: "me" | "others"
  after?: string
  before?: string
}

export const fileBrowserAPI = {
  browse: (query: FileBrowseQuery, signal?: AbortSignal): Promise<FileListing> => get(`/files/browse?${queryOf(query)}`, { signal }),

  search: (query: FileSearchQuery, signal?: AbortSignal): Promise<FileListing> => get(`/files/search?${queryOf(query)}`, { signal }),

  createFolder: (body: {
    name: string
    color?: FolderColor
    icon?: SymbolKey | null
    parentId?: string | null
    projectId?: string | null
  }): Promise<FolderItem> => post("/files/folders", body),

  updateFolder: (
    id: string,
    body: { name?: string; color?: FolderColor; icon?: SymbolKey | null; parentId?: string | null },
  ): Promise<FolderItem> => patch(`/files/folders/${id}`, body),

  trashFolder: (id: string): Promise<void> => del(`/files/folders/${id}`),
  restoreFolder: (id: string): Promise<void> => post(`/files/folders/${id}/restore`),
  purgeFolder: (id: string): Promise<void> => del(`/files/folders/${id}/forever`),

  updateFile: (id: string, body: { name?: string; folderId?: string | null; altText?: string | null }): Promise<FileItem> =>
    patch(`/files/${id}`, body),

  trashFile: (id: string): Promise<void> => del(`/files/${id}`),
  restoreFile: (id: string): Promise<void> => post(`/files/${id}/restore`),
  purgeFile: (id: string): Promise<void> => del(`/files/${id}/forever`),
  copyFile: (id: string): Promise<FileItem> => post(`/files/${id}/copy`),
}

// fetch reports no upload progress, so an upload that shows it goes through XHR with the same auth
async function uploadWithProgress(
  path: string,
  form: FormData,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<FileAttachment> {
  const token = await getToken()
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `${getApiBaseUrl()}${path}`)
    xhr.timeout = TRANSFER_TIMEOUT_MS
    xhr.withCredentials = !isTauri()
    for (const [name, value] of Object.entries(clientHeaders())) xhr.setRequestHeader(name, value)
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total)
    }
    xhr.onload = async () => {
      if (xhr.status === 401) {
        try {
          await handleUnauthorized()
        } catch {
          // The upload still settles when signing out fails
        }
        return reject(new ApiError(401, { error: "Unauthorized" }))
      }
      let data: Record<string, unknown> = {}
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        data = { error: xhr.statusText }
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as unknown as FileAttachment)
      noticeReadOnly(xhr.status, data)
      reject(new ApiError(xhr.status, data))
    }
    xhr.onerror = () => reject(new TypeError("Network request failed"))
    xhr.ontimeout = () => reject(new DOMException("The upload timed out", "AbortError"))
    xhr.onabort = () => reject(new DOMException("The upload was cancelled", "AbortError"))
    if (signal?.aborted) return reject(new DOMException("The upload was cancelled", "AbortError"))
    signal?.addEventListener("abort", () => xhr.abort(), { once: true })
    xhr.send(form)
  })
}

export const filesAPI = {
  uploadFile: async (file: File, options: UploadOptions = {}): Promise<FileAttachment> => {
    const formData = new FormData()
    formData.append("file", file)
    const query = new URLSearchParams()
    if (options.purpose) query.set("purpose", options.purpose)
    if (options.projectId) query.set("projectId", options.projectId)
    if (options.folderId) query.set("folderId", options.folderId)
    if (options.docId) query.set("docId", options.docId)
    if (options.shareId) query.set("shareId", options.shareId)
    const qs = query.toString()
    const path = qs ? `/files/upload?${qs}` : "/files/upload"
    if (options.onProgress) return uploadWithProgress(path, formData, options.onProgress, options.signal)
    return request(path, { method: "POST", body: formData, signal: options.signal })
  },

  attachFile: (params: { fileId: string; messageId?: string; taskId?: string; commentId?: string }): Promise<Attachment> =>
    post("/files/attach", params),

  /** Takes a file off a message, which only its sender may do. The file stays with its owner */
  removeFromMessage: (messageId: string, fileId: string): Promise<ChatMessage> => del(`/messages/${messageId}/attachments/${fileId}`),

  /** Takes a file off a task, for anyone who can edit it */
  removeFromTask: (taskId: string, fileId: string): Promise<void> => del(`/tasks/${taskId}/attachments/${fileId}`),

  downloadFile: async (fileId: string, signal?: AbortSignal): Promise<Blob> => {
    return get(`/files/${fileId}/download`, { responseType: "blob", signal, timeoutMs: TRANSFER_TIMEOUT_MS })
  },
}
