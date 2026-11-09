/** Any S3-compatible store: the bundled Garage (AGPL-3.0), AWS, Cloudflare R2, Backblaze B2, Hetzner or MinIO */
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import type { Readable } from "stream"
import { CHECK_TIMEOUT_MS } from "../../utils/timedCheck"
import { StorageMissing, type StorageDriver } from "./driver"

export type S3Settings = { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; forcePathStyle: boolean }

type StoreError = { name?: string; message?: string; $metadata?: { httpStatusCode?: number } }

const isMissing = (caught: unknown) => (caught as StoreError | null)?.name === "NoSuchKey"

// A HEAD answer has no body, so the SDK only knows the status and calls the error UnknownError
function storageReason(caught: unknown, { endpoint, bucket }: S3Settings): string {
  const error = caught as StoreError
  const status = error.$metadata?.httpStatusCode
  if (status === undefined) {
    return `The file storage at ${endpoint} did not answer${error.message ? ` (${error.message})` : ""}. Check S3_ENDPOINT in .env.`
  }
  if (status === 404) return `The bucket ${bucket} does not exist. Check S3_BUCKET in .env.`
  if (status === 403) return `The keys in S3_ACCESS_KEY and S3_SECRET_KEY are wrong, or may not use the bucket ${bucket}.`
  if (status === 301 || status === 400) {
    return `The file storage refused the request for the bucket ${bucket}. Check S3_REGION and S3_FORCE_PATH_STYLE in .env.`
  }
  if (error.message && error.message !== "UnknownError") return error.message
  return `The file storage answered with HTTP ${status}.`
}

export function s3Driver(settings: S3Settings): StorageDriver {
  const Bucket = settings.bucket
  const client = new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    credentials: { accessKeyId: settings.accessKey, secretAccessKey: settings.secretKey },
    forcePathStyle: settings.forcePathStyle,
    // R2, B2 and MinIO reject the checksum headers the SDK sends by default
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })

  return {
    // In parts, holding at most two in memory. A failed upload is aborted, so no part of it stays
    async put(key, stream, contentType) {
      await new Upload({ client, params: { Bucket, Key: key, Body: stream, ContentType: contentType }, queueSize: 2 }).done()
    },

    async get(key) {
      const response = await client.send(new GetObjectCommand({ Bucket, Key: key })).catch((caught: unknown) => {
        throw isMissing(caught) ? new StorageMissing(key) : caught
      })
      if (!response.Body) throw new StorageMissing(key)
      return response.Body as Readable
    },

    // Server-side, so the bytes never pass through Nerla
    async copy(from, to) {
      const CopySource = `${Bucket}/${from.split("/").map(encodeURIComponent).join("/")}`
      await client.send(new CopyObjectCommand({ Bucket, Key: to, CopySource })).catch((caught: unknown) => {
        throw isMissing(caught) ? new StorageMissing(from) : caught
      })
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }), { abortSignal: AbortSignal.timeout(30_000) })
    },

    async check() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }), { abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
      } catch (caught) {
        throw new Error(storageReason(caught, settings))
      }
    },
  }
}
