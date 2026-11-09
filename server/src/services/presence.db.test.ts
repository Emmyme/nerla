import { setTimeout as sleep } from "node:timers/promises"
import { eq } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, expect, it } from "vitest"
import { db, users } from "../db"
import { addJob, runDueJobs } from "../jobs/queue"
import { caller, testApp } from "../test/app"
import { makeWorkspace } from "../test/factories"

let app: FastifyInstance

beforeAll(async () => {
  app = await testApp()
})

afterAll(() => app.close())

const stored = async (id: string) =>
  db.query.users.findFirst({ where: eq(users.id, id), columns: { statusOverride: true, statusUntil: true } })

// The server keeps no timer for a status, so the job alone ends it, whichever process runs it after a restart
it("a status ends at its time, also after a restart", async () => {
  const { adminId } = await makeWorkspace()
  const as = caller(app, adminId)
  const later = new Date(Date.now() + 60_000).toISOString()
  expect((await as("PUT", "/api/presence/status", { status: "dnd", until: later })).statusCode).toBe(200)
  const until = new Date(Date.now() + 1000)
  const res = await as("PUT", "/api/presence/status", { status: "busy", until: until.toISOString() })
  expect(res.statusCode, res.payload).toBe(200)

  // A job for an end that was since replaced leaves the status alone
  await addJob(db, "status.clear", { userId: adminId, organizationId: "x", value: "busy", until: new Date(0).toISOString() })
  expect(await runDueJobs()).toBe(1)
  expect((await stored(adminId))?.statusOverride).toBe("busy")

  await sleep(until.getTime() - Date.now() + 50)
  expect(await runDueJobs()).toBe(1)
  expect(await stored(adminId)).toEqual({ statusOverride: null, statusUntil: null })
})
