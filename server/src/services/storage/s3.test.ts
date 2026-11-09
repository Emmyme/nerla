import { createServer, type IncomingMessage } from "http"
import type { AddressInfo } from "net"
import { Readable } from "stream"
import { afterAll, beforeAll, expect, it } from "vitest"
import { s3Driver } from "./s3"

// Answers as R2, B2 and MinIO do to the checksum headers newer SDKs send by default
const objects = new Map<string, Buffer>()
const sendsChecksum = (req: IncomingMessage) =>
  Object.keys(req.headers).some((name) => name.startsWith("x-amz-checksum-") || name === "x-amz-sdk-checksum-algorithm")
const server = createServer(async (req, res) => {
  if (sendsChecksum(req)) return res.writeHead(400).end("Checksum headers are not supported")
  const path = new URL(req.url ?? "/", "http://store").pathname
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk)
  if (req.method === "PUT") {
    objects.set(path, Buffer.concat(chunks))
    return res.writeHead(200, { ETag: '"1"' }).end()
  }
  const body = objects.get(path)
  if (req.method === "GET" && body) return res.writeHead(200, { "Content-Length": body.length }).end(body)
  res.writeHead(404).end()
})
let endpoint = ""
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
})

it("put then get works with a store that refuses checksum headers", async () => {
  const driver = s3Driver({ endpoint, region: "auto", bucket: "nerla", accessKey: "key", secretKey: "secret", forcePathStyle: true })
  await driver.put("orgs/a/file.txt", Readable.from([Buffer.from("hello")]), "text/plain")
  expect(Buffer.concat(await (await driver.get("orgs/a/file.txt")).toArray()).toString()).toBe("hello")
})
