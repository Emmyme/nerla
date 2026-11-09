/** Picks the file store from the settings. Everything else in Nerla reaches the store through here */
import { randomUUID } from "crypto"
import type { FastifyBaseLogger, FastifyReply } from "fastify"
import type { Readable } from "stream"
import { storageConfig } from "../config"
import { attachmentDisposition, safeExtension } from "../utils/fileHeaders"
import { timedCheck, type CheckResult } from "../utils/timedCheck"
import { StorageMissing, type StorageDriver } from "./storage/driver"
import { DISK_FULL, localDriver, removeTempFiles, type LocalSettings } from "./storage/local"
import { s3Driver, type S3Settings } from "./storage/s3"
import { errorText } from "../utils/errorText"

/** The settings can't make a store, so nothing is tried. The message names each setting to fix */
class StorageUnset extends Error {}

let current: StorageDriver | null = null

/** One store for the process. A failed setup is not kept, so fixed settings work without a restart */
function storage(): StorageDriver {
  if (current) return current
  const settings = storageConfig(process.env)
  if (Array.isArray(settings)) throw new StorageUnset(settings.map((problem) => problem.message).join(" "))
  current = driverFor(settings)
  // Not awaited, as only hour-old temp files go. It logs what it removes and any error itself
  if ("root" in settings) void removeTempFiles(settings)
  return current
}

/** The store a set of settings names. ./nerla move-files builds its target with it too */
export const driverFor = (settings: S3Settings | LocalSettings): StorageDriver =>
  "root" in settings ? localDriver(settings) : s3Driver(settings)

export async function ensureBucketExists() {
  try {
    storage()
    console.log("✅ File storage is configured")
  } catch (caught) {
    console.error(`❌ ${errorText(caught)}`)
    console.error("   For the bundled storage, run ./setup.sh (Linux/Mac) or .\\setup.ps1 (Windows) again to generate keys.")
    // The server starts without file storage, and the setup check keeps showing what to fix
  }
}

/** Reaches the store with the configured settings */
export function checkStorage(): Promise<CheckResult> {
  return timedCheck(() => storage().check())
}

// Async, so settings that can't make a store reject and a caller's .catch sees it
/** Deleting a key that is already gone succeeds, so a retry after a crash is safe */
export const deleteObject = async (key: string): Promise<void> => storage().delete(key)

export const copyObject = async (fromKey: string, toKey: string): Promise<void> => storage().copy(fromKey, toKey)

/** Streams a body into the store. A failed put leaves nothing behind */
export const putObjectStream = async (key: string, body: Readable, contentType: string): Promise<void> =>
  storage().put(key, body, contentType)

/** The stored bytes. Throws `StorageMissing` when the store has no such key */
export const getObject = async (key: string): Promise<Readable> => storage().get(key)

/** Objects of a workspace sit under its own prefix. An avatar is the user's own, in every workspace */
export function objectKey(purpose: "attachment" | "avatar", organizationId: string, userId: string, fileName: string): string {
  const name = `${randomUUID()}.${safeExtension(fileName)}`
  return purpose === "avatar" ? `users/${userId}/avatars/${name}` : `orgs/${organizationId}/attachments/${userId}/${name}`
}

type StoreError = { name?: string; message?: string; code?: string; $metadata?: { httpStatusCode?: number } }

/** What to answer when the store fails, or null for an error that is not the store's */
export function storageRefusal(caught: unknown): { status: number; error: string } | null {
  if (caught instanceof StorageMissing) return { status: 404, error: "File not found in storage" }
  if (caught instanceof StorageUnset) {
    return { status: 503, error: "File storage is not set up. An admin can open the setup check, which names the setting to fix." }
  }
  const error = caught as StoreError | null | undefined
  if (error?.code === "ENOSPC") return { status: 507, error: DISK_FULL }
  if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") {
    return {
      status: 503,
      error: "The server can't write to the file storage folder. An admin can open the setup check, which says what to fix.",
    }
  }
  if (error?.code === "ECONNREFUSED" || error?.code === "ENOTFOUND" || error?.name === "ECONNREFUSED") {
    return { status: 503, error: "File storage does not answer. An admin can check that S3_ENDPOINT in .env points at it." }
  }
  if (error?.$metadata?.httpStatusCode === 403 || error?.name === "Forbidden" || error?.name === "AccessDenied") {
    const message = String(error.message || "")
    if (message.includes("No such key") || message.includes("GK...")) {
      return {
        status: 503,
        error:
          "File storage keys are not set up. An admin can set S3_ACCESS_KEY and S3_SECRET_KEY in .env, or run ./setup.sh (Linux/Mac) or .\\setup.ps1 (Windows) again for the bundled storage, then restart the server.",
      }
    }
    return {
      status: 503,
      error: "File storage refused access. An admin can check that S3_ACCESS_KEY and S3_SECRET_KEY in .env may use S3_BUCKET.",
    }
  }
  if (error?.name === "NoSuchBucket" || error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") {
    return { status: 503, error: "The file storage bucket does not exist. An admin can check S3_BUCKET in .env." }
  }
  return null
}

type StoredFile = { filePath: string; fileName: string; mimeType: string | null; fileSize: number }

function downloadHeaders(reply: FastifyReply, file: StoredFile): void {
  reply.header("Content-Disposition", attachmentDisposition(file.fileName))
  reply.header("Content-Type", file.mimeType || "application/octet-stream")
  reply.header("X-Content-Type-Options", "nosniff")
  reply.header("Content-Length", file.fileSize.toString())
}

/**
 * Streams a stored file as a download of its stored type. `onStart` runs once the store has the object. A HEAD
 * request gets the headers alone, without reading the store or running `onStart`
 */
export async function sendDownload(
  reply: FastifyReply,
  file: StoredFile,
  log: FastifyBaseLogger,
  onStart?: () => Promise<unknown>,
): Promise<FastifyReply> {
  if (reply.request.method === "HEAD") {
    downloadHeaders(reply, file)
    return reply.send()
  }
  let body: Readable
  try {
    body = await getObject(file.filePath)
  } catch (error) {
    const refusal = storageRefusal(error)
    if (refusal) return reply.code(refusal.status).send({ error: refusal.error })
    log.error({ err: error }, "Error downloading file from storage")
    return reply.code(500).send({ error: "Failed to download file" })
  }
  body.on("error", (err) => log.error({ err }, "Error streaming file from storage"))
  try {
    await onStart?.()
  } catch (error) {
    body.destroy()
    throw error
  }
  downloadHeaders(reply, file)
  return reply.send(body)
}
