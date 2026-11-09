import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, expect, it } from "vitest"
import { caller, testApp } from "../test/app"
import { makeTask, makeUser, makeWorkspace } from "../test/factories"
import type { Step } from "../utils/onboarding"

let app: FastifyInstance

beforeAll(async () => {
  app = await testApp()
})

afterAll(() => app.close())

const stepsOf = async (as: ReturnType<typeof caller>) => {
  const res = await as("GET", "/api/users/onboarding")
  expect(res.statusCode, res.payload).toBe(200)
  const body = res.json<{ welcomeSeen: boolean; steps: Step[] }>()
  return { welcomeSeen: body.welcomeSeen, steps: Object.fromEntries(body.steps.map((step) => [step.id, step.state])) }
}

it("starts with nothing done, ticks a step once done and shows the admin steps to admins only", async () => {
  const { orgId, adminId } = await makeWorkspace()
  const admin = caller(app, adminId)

  const fresh = await stepsOf(admin)
  expect(fresh.welcomeSeen).toBe(false)
  // No AI is set up, so asking it is left out
  expect(fresh.steps).toEqual({
    profile: "todo",
    task: "todo",
    event: "todo",
    message: "todo",
    doc: "todo",
    desktop: "todo",
    invite: "todo",
    setup: "todo",
    aiOn: "todo",
  })

  await makeTask(orgId, { assignedTo: adminId })
  expect((await admin("PUT", "/api/users/onboarding", { welcomeSeen: true, skip: "aiOn" })).statusCode).toBe(200)
  expect((await admin("PUT", "/api/users/onboarding", { skip: "task" })).statusCode).toBe(400)

  const invited = await admin("POST", "/api/organizations/invite", {
    email: `new-${orgId}@test.nerla.local`,
    firstName: "New",
    lastName: "Member",
  })
  expect(invited.statusCode, invited.payload).toBeLessThan(300)

  const after = await stepsOf(admin)
  expect(after.welcomeSeen).toBe(true)
  expect(after.steps).toMatchObject({ task: "done", invite: "done", aiOn: "skipped", event: "todo" })

  const { adminId: otherAdmin } = await makeWorkspace()
  const member = caller(app, await makeUser(orgId))
  expect(Object.keys((await stepsOf(member)).steps)).toEqual(["profile", "task", "event", "message", "doc", "desktop"])
  // The admin's own task never ticks another user's step
  expect((await stepsOf(caller(app, otherAdmin))).steps.task).toBe("todo")
})
