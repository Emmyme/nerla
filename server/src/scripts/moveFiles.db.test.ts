import { randomBytes } from "crypto"
import { mkdtempSync } from "fs"
import { rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { Readable } from "stream"
import { eq } from "drizzle-orm"
import { afterAll, expect, it } from "vitest"
import { db, fileAttachments } from "../db"
import { StorageMissing } from "../services/storage/driver"
import { localDriver } from "../services/storage/local"
import { makeUser, makeWorkspace } from "../test/factories"
import { moveFiles, reusesS3Lines } from "./moveFiles"

const space = mkdtempSync(join(tmpdir(), "nerla-move-files-"))
const source = localDriver({ root: join(space, "from") })
const target = localDriver({ root: join(space, "to") })
afterAll(() => rm(space, { recursive: true, force: true }))

const files = Array.from({ length: 20 }, (_, i) => ({ key: `orgs/test/attachments/${i}.bin`, bytes: randomBytes(100 + i * 37) }))
const lines: string[] = []
const log = (line: string) => lines.push(line)
const bytesOf = async (key: string) => Buffer.concat(await (await target.get(key)).toArray())
const inSource = async (key: string) => (await source.get(key)).destroy()

it("moves 20 files across a stopped run, checks each and deletes nothing from the source", async () => {
  const { orgId, adminId } = await makeWorkspace()
  const userId = await makeUser(orgId)
  for (const { key, bytes } of files) await source.put(key, Readable.from([bytes]), "application/octet-stream")
  const row = (i: number) => ({ fileName: `file-${i}.bin`, filePath: files[i].key, fileSize: files[i].bytes.length, organizationId: orgId })
  await db.insert(fileAttachments).values([...files.keys()].slice(0, 18).map((i) => ({ ...row(i), uploadedBy: userId })))
  await db.insert(fileAttachments).values([18, 19].map((i) => ({ ...row(i), uploadedBy: adminId })))
  await db.insert(fileAttachments).values({ fileName: "Notes", filePath: "doc:1", fileSize: 3, uploadedBy: userId, organizationId: orgId })

  const first = await moveFiles({ source, target, limit: 7, log })
  expect([first.copied, first.failed]).toEqual([7, []])
  const second = await moveFiles({ source, target, log })
  expect([second.skipped, second.copied, second.failed]).toEqual([7, 13, []])
  const sameFolder = localDriver({ root: join(space, "from") })
  await expect(moveFiles({ source, target: sameFolder, deleteSource: true, log })).rejects.toThrow("same as the current one")

  for (const { key, bytes } of files) {
    expect((await bytesOf(key)).equals(bytes)).toBe(true)
    await inSource(key)
  }
})

it("reports a missing source file by name, moves the rest and deletes only once every file checks out", async () => {
  const [{ organizationId, uploadedBy }] = await db.select().from(fileAttachments).limit(1)
  const lost = { fileName: "lost-report.pdf", filePath: "orgs/test/attachments/lost.pdf", fileSize: 10, organizationId, uploadedBy }
  await db.insert(fileAttachments).values(lost)
  await rm(join(space, "to"), { recursive: true })

  const partial = await moveFiles({ source, target, deleteSource: true, log })
  expect([partial.copied, partial.failed.map((failure) => failure.key), partial.deleted]).toEqual([20, [lost.filePath], 0])
  expect(lines.some((line) => line.includes("lost-report.pdf"))).toBe(true)
  for (const { key } of files) await inSource(key)

  await db.delete(fileAttachments).where(eq(fileAttachments.filePath, lost.filePath))
  const full = await moveFiles({ source, target, deleteSource: true, log })
  expect([full.skipped, full.failed, full.deleted]).toEqual([20, [], 20])
  for (const { key, bytes } of files) {
    await expect(inSource(key)).rejects.toThrow(StorageMissing)
    expect((await bytesOf(key)).equals(bytes)).toBe(true)
  }
})

it("a file deleted in Nerla during the move is deleted from the new store too", async () => {
  const [{ organizationId, uploadedBy }] = await db.select().from(fileAttachments).limit(1)
  const gone = { fileName: "gone.txt", filePath: "orgs/test/attachments/gone.txt", fileSize: 4, organizationId, uploadedBy }
  await db.insert(fileAttachments).values(gone)
  await source.put(gone.filePath, Readable.from([Buffer.from("gone")]), "text/plain")
  const deletesOnCopy = {
    ...target,
    put: async (...args: Parameters<typeof target.put>) => {
      await target.put(...args)
      if (args[0] === gone.filePath) await db.delete(fileAttachments).where(eq(fileAttachments.filePath, gone.filePath))
    },
  }

  const result = await moveFiles({ source, target: deletesOnCopy, log })
  expect([result.copied, result.failed]).toEqual([1, []])
  await expect(target.get(gone.filePath)).rejects.toThrow(StorageMissing)
})

const GARAGE = "http://garage:3900"
const s3 = { endpoint: GARAGE, region: "garage", bucket: "nerla-files", accessKey: "GK1", secretKey: "s", forcePathStyle: true }
it.each([
  ["from local disk with no MOVE_TO_S3_ENDPOINT", {}, { root: "/data/files" }, true],
  ["from local disk with another endpoint", { MOVE_TO_S3_ENDPOINT: "https://s3.example.com" }, { root: "/data/files" }, false],
  ["from S3", {}, s3, false],
])("the S3_ lines are reused %s", (_name, env, from, reuses) => {
  expect(reusesS3Lines({ S3_ENDPOINT: GARAGE, ...env }, from)).toBe(reuses)
})
