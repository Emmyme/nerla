import { ListMultipartUploadsCommand, S3Client } from "@aws-sdk/client-s3"
import { afterAll, expect, it } from "vitest"
import { storageContract } from "./contract"
import { s3Driver, type S3Settings } from "./s3"

const env = (name: string) => process.env[name]?.trim() || undefined
const endpoint = env("TEST_S3_ENDPOINT")

if (endpoint) {
  const settings: S3Settings = {
    endpoint,
    region: env("TEST_S3_REGION") ?? "garage",
    bucket: env("TEST_S3_BUCKET") ?? "nerla-e2e",
    accessKey: env("TEST_S3_ACCESS_KEY") ?? "",
    secretKey: env("TEST_S3_SECRET_KEY") ?? "",
    forcePathStyle: env("TEST_S3_FORCE_PATH_STYLE") !== "false",
  }
  storageContract("S3", () => s3Driver(settings))

  // A put that failed after sending a part must abort its upload, or the parts stay stored and billed out of sight
  afterAll(async () => {
    const client = new S3Client({
      endpoint,
      region: settings.region,
      credentials: { accessKeyId: settings.accessKey, secretAccessKey: settings.secretKey },
      forcePathStyle: settings.forcePathStyle,
    })
    const { Uploads } = await client.send(new ListMultipartUploadsCommand({ Bucket: settings.bucket, Prefix: "contract/" }))
    client.destroy()
    expect(Uploads ?? []).toEqual([])
  })
} else {
  it.skip("the S3 storage contract needs a real store, set TEST_S3_ENDPOINT, TEST_S3_ACCESS_KEY and TEST_S3_SECRET_KEY to run it")
}
