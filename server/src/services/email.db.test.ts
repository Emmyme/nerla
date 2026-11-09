import { randomBytes } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import type { SendMailOptions } from "nodemailer"
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest"
import { db, jobs } from "../db"
import { addJob, runDueJobs } from "../jobs/queue"
import { caller, testApp } from "../test/app"
import { makeWorkspace } from "../test/factories"
import { setTransportForTests } from "./email"

let app: FastifyInstance
let sent: SendMailOptions[] = []
let failures = 0

beforeAll(async () => {
  process.env.EMAIL_USER = "test"
  process.env.EMAIL_PASS = "test"
  app = await testApp()
  setTransportForTests(async (mail) => {
    if (failures > 0) {
      failures--
      throw new Error("The mail server did not answer")
    }
    sent.push(mail)
  })
})

beforeEach(async () => {
  await db.execute(sql`delete from jobs`)
  sent = []
  failures = 0
})

afterAll(() => app.close())

async function invite() {
  const { adminId } = await makeWorkspace()
  const as = caller(app, adminId)
  const email = `new-${randomBytes(4).toString("hex")}@test.nerla.local`
  const res = await as("POST", "/api/organizations/invite", { email })
  expect(res.statusCode, res.payload).toBe(201)
  const emailStatus = async () =>
    (await as("GET", "/api/organizations/invitations")).json<{ email: string; emailStatus: string }[]>().find((i) => i.email === email)
      ?.emailStatus
  const revoke = async () => as("DELETE", `/api/organizations/invitations/${((await job()).payload as { userId: string }).userId}`)
  return { body: res.json<{ inviteUrl: string; email: string }>(), emailStatus, revoke }
}

const job = async () => (await db.select().from(jobs).where(eq(jobs.kind, "email.invite")))[0]
const retryNow = async () => {
  await db.execute(sql`update jobs set run_at = now() where status = 'pending'`)
  return runDueJobs()
}

it("an invite email is retried until the mail server answers", async () => {
  failures = 2
  const { body, emailStatus } = await invite()
  expect(body.email).toBe("sending")
  expect(await runDueJobs()).toBe(1)
  expect(await emailStatus()).toBe("sending")
  await retryNow()
  await retryNow()
  expect(await job()).toMatchObject({ status: "done", attempts: 3 })
  expect(sent).toHaveLength(1)
  expect(await emailStatus()).toBe("sent")
})

it("an invite email that keeps failing reads failed", async () => {
  failures = Infinity
  const { emailStatus } = await invite()
  await runDueJobs()
  for (let attempt = 2; attempt <= 6; attempt++) await retryNow()
  expect(await job()).toMatchObject({ status: "failed", attempts: 6, lastError: "The mail server did not answer" })
  expect(await retryNow()).toBe(0)
  expect(await emailStatus()).toBe("failed")
})

it("the link in a job is sealed", async () => {
  const { body } = await invite()
  const token = new URL(body.inviteUrl).searchParams.get("token")!
  expect(JSON.stringify((await job()).payload)).not.toContain(token)
  await runDueJobs()
  expect(sent[0].text).toContain(body.inviteUrl)
  expect((await job()).payload).not.toHaveProperty("token")

  // A link sealed under another key never heals, so it fails at once with what to do
  await db.execute(sql`delete from jobs`)
  await addJob(db, "email.invite", { userId: "x", to: "a@test.nerla.local", token: "AAAA.AAAA.AAAA", inviterName: "A", orgName: "B" })
  await runDueJobs()
  expect(await job()).toMatchObject({
    status: "failed",
    attempts: 1,
    lastError: "This email's link can't be read any more. Make a new link.",
  })

  // A rerun after a send whose finish was lost finds the link already dropped, and ends done without a second email
  await db.execute(sql`delete from jobs`)
  sent = []
  await addJob(db, "email.invite", { userId: "x", to: "a@test.nerla.local", inviterName: "A", orgName: "B" })
  await runDueJobs()
  expect(await job()).toMatchObject({ status: "done", attempts: 1 })
  expect(sent).toHaveLength(0)
})

it("a queued invite whose invite was revoked sends nothing", async () => {
  failures = 1
  const { revoke } = await invite()
  await runDueJobs()
  expect((await revoke()).statusCode).toBe(200)
  await retryNow()
  expect(await job()).toMatchObject({ status: "done", attempts: 2 })
  expect(sent).toHaveLength(0)
})
