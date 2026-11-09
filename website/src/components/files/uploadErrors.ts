import { ApiError } from "@/lib/api/request"
import { organizationsAPI } from "@/lib/api/organizations"
import { messageOf } from "@/lib/taskStore"
import { formatFileSize } from "./fileKinds"

const FULL_FOR_PERSON = "Your storage is full. Free up space in Files or ask an admin."
const FULL_FOR_WORKSPACE = "The workspace storage is full. Ask an admin."
const UPLOAD_FAILED = "Couldn't upload the file. Check your connection and try again."

export const overLimit = (limit: number) => `This file is over the ${formatFileSize(limit)} limit.`

/** The plan's copy for a refused upload or copy, from the 413 body. Null for anything else */
export function capRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 413) return null
  if (err.data.error === "person-full") return FULL_FOR_PERSON
  if (err.data.error === "workspace-full") return FULL_FOR_WORKSPACE
  const limit = typeof err.data.limit === "number" ? err.data.limit : null
  return limit ? overLimit(limit) : "This file is too large."
}

/** Whether a refusal means every other file of the batch is refused too */
export const isFull = (message: string) => message === FULL_FOR_PERSON || message === FULL_FOR_WORKSPACE

/** The workspace's largest upload, the admin's limit or the server's own, whichever is lower */
async function workspaceUploadLimit(): Promise<number | null> {
  const org = await organizationsAPI.getCurrentOrganization().catch(() => null)
  const limits = [org?.maxFileSize, org?.uploadCeiling].filter((limit): limit is number => typeof limit === "number" && limit > 0)
  return limits.length ? Math.min(...limits) : null
}

/** One organization read for a whole batch, made only when a file needs it */
export function batchLimit(): () => Promise<number | null> {
  let limit: Promise<number | null> | null = null
  return () => (limit ??= workspaceUploadLimit())
}

/**
 * What to say about a failed upload. A browser can report a refusal that came before the upload finished as a
 * network error, so the limit is checked then
 */
export async function uploadFailure(
  err: unknown,
  file: File,
  limit: () => Promise<number | null> = batchLimit(),
  fallback = UPLOAD_FAILED,
): Promise<string> {
  const refusal = capRefusal(err)
  if (refusal) return refusal
  if (err instanceof TypeError && file.size > 1024 * 1024) {
    const max = await limit()
    if (max && file.size > max) return overLimit(max)
  }
  return messageOf(err, fallback)
}
