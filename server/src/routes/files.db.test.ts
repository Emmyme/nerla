import type { Readable } from "node:stream"
import { and, eq, sql } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { db, fileAttachments, fileFolders, jobs } from "../db"
import { runDueJobs } from "../jobs/queue"
import { purgeFile } from "../services/files"
import { caller, signedIn, testApp } from "../test/app"
import { makeUser, makeWorkspace } from "../test/factories"

const storage = vi.hoisted(() => ({ keys: new Set<string>(), during: async () => {}, deleteFailures: 0 }))
vi.mock("../services/storage", async (original) => ({
  ...(await original<typeof import("../services/storage")>()),
  putObjectStream: async (key: string, body: Readable) => {
    await body.toArray()
    await storage.during()
    storage.keys.add(key)
  },
  deleteObject: async (key: string) => {
    if (storage.deleteFailures-- > 0) throw new Error("The storage did not answer.")
    storage.keys.delete(key)
  },
}))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(24).fill(0)])
const BOUNDARY = "nerla-test-boundary"
let address = 0

async function upload(userId: string, query: string) {
  const payload = Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="cat.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ])
  const headers = { ...(await signedIn(app, userId)), "content-type": `multipart/form-data; boundary=${BOUNDARY}` }
  address++
  return app.inject({ method: "POST", url: `/api/files/upload?${query}`, headers, payload, remoteAddress: `10.1.0.${address}` })
}

const avatars = (userId: string, orgId: string, n: number) =>
  db.insert(fileAttachments).values(
    Array.from({ length: n }, (_, i) => ({
      fileName: `avatar-${i}.png`,
      filePath: `users/${userId}/avatars/${i}.png`,
      fileSize: 10,
      mimeType: "image/png",
      uploadedBy: userId,
      organizationId: orgId,
      kind: "avatar",
    })),
  )

let app: FastifyInstance

beforeAll(async () => {
  app = await testApp()
})

beforeEach(() => {
  storage.keys.clear()
  storage.during = async () => {}
  storage.deleteFailures = 0
})

afterAll(() => app.close())

describe("profile pictures", () => {
  it("refuses the 21st picture in a day", async () => {
    const { orgId } = await makeWorkspace()
    const userId = await makeUser(orgId)
    await avatars(userId, orgId, 20)
    const res = await caller(app, userId)("POST", "/api/files/upload?purpose=avatar")
    expect([res.statusCode, res.json()]).toEqual([429, { error: "You've changed your picture a lot today. Try again tomorrow." }])
  })

  it("saves one of three pictures sent at once by a user with 19 today", async () => {
    const { orgId } = await makeWorkspace()
    const userId = await makeUser(orgId)
    await avatars(userId, orgId, 19)
    // All three pass the early check, and none is saved before every one has streamed
    let arrived = 0
    let open = () => {}
    const streamed = new Promise<void>((resolve) => (open = resolve))
    storage.during = async () => {
      if (++arrived === 3) open()
      await streamed
    }
    const results = await Promise.all([1, 2, 3].map(() => upload(userId, "purpose=avatar")))
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 429, 429])
    for (const res of results.filter((res) => res.statusCode === 429)) {
      expect(res.json()).toEqual({ error: "You've changed your picture a lot today. Try again tomorrow." })
    }
    const saved = await db.select().from(fileAttachments).where(eq(fileAttachments.uploadedBy, userId))
    expect(saved).toHaveLength(20)
    await runDueJobs()
    expect([...storage.keys]).toEqual([saved.find((row) => row.id === results.find((res) => res.statusCode === 200)!.json().id)!.filePath])
  })
})

describe("uploads", () => {
  it("refuse a file whose folder went to the trash while it uploaded", async () => {
    const { orgId } = await makeWorkspace()
    const userId = await makeUser(orgId)
    const [folder] = await db.insert(fileFolders).values({ name: "Drafts", organizationId: orgId, createdBy: userId }).returning()
    storage.during = async () => {
      await db.update(fileFolders).set({ deletedAt: new Date().toISOString() }).where(eq(fileFolders.id, folder.id))
    }
    const res = await upload(userId, `purpose=file&folderId=${folder.id}`)
    expect([res.statusCode, res.json()]).toEqual([409, { error: "That folder was moved to the trash while the file uploaded." }])
    expect(await db.select().from(fileAttachments).where(eq(fileAttachments.uploadedBy, userId))).toEqual([])
    await runDueJobs()
    expect(storage.keys.size).toBe(0)
  })
})

describe("stored files", () => {
  it("a stored file is deleted after its record, even when storage fails first", async () => {
    const { orgId } = await makeWorkspace()
    const userId = await makeUser(orgId)
    const stored = async (name: string) => {
      const [row] = await db
        .insert(fileAttachments)
        .values({ fileName: name, filePath: `files/${userId}/${name}`, fileSize: 10, uploadedBy: userId, organizationId: orgId })
        .returning()
      storage.keys.add(row.filePath)
      return row
    }
    const jobsFor = (path: string) =>
      db
        .select()
        .from(jobs)
        .where(and(eq(jobs.kind, "storage.delete"), eq(jobs.uniqueKey, `storage:${path}`)))

    const kept = await stored("kept.png")
    const undone = db.transaction(async (tx) => {
      await purgeFile(kept.id, { expect: "any" }, tx)
      throw new Error("rolled back")
    })
    await expect(undone).rejects.toThrow("rolled back")
    expect(await jobsFor(kept.filePath)).toEqual([])

    const gone = await stored("gone.png")
    await db.transaction((tx) => purgeFile(gone.id, { expect: "any" }, tx))
    expect(await jobsFor(gone.filePath)).toHaveLength(1)
    storage.deleteFailures = 1
    await runDueJobs()
    expect(storage.keys.has(gone.filePath)).toBe(true)
    expect((await jobsFor(gone.filePath)).map((job) => [job.status, job.attempts])).toEqual([["pending", 1]])
    await db.execute(sql`update jobs set run_at = now() where status = 'pending'`)
    await runDueJobs()
    expect([...storage.keys]).toEqual([kept.filePath])
    expect((await jobsFor(gone.filePath)).map((job) => [job.status, job.attempts])).toEqual([["done", 2]])
  })
})
