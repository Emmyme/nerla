import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { caller, testApp } from "../test/app"
import { makeUser, makeWorkspace } from "../test/factories"

let app: FastifyInstance

beforeAll(async () => {
  app = await testApp()
})

afterAll(() => app.close())

/** The user's bell titles, once the notice sent after the reply has landed */
async function bell(as: ReturnType<typeof caller>, count: number): Promise<string[]> {
  for (let tries = 0; ; tries++) {
    const titles = ((await as("GET", "/api/notifications")).json() as { items: { title: string }[] }).items.map((item) => item.title)
    if (titles.length >= count || tries === 20) return titles
    await new Promise((done) => setTimeout(done, 100))
  }
}

describe("an event invite", () => {
  it("tells only the users newly invited", async () => {
    const { orgId, adminId } = await makeWorkspace()
    const [first, second] = [await makeUser(orgId), await makeUser(orgId)]
    const organiser = caller(app, adminId)
    const created = await organiser("POST", "/api/calendar", {
      title: "Planning",
      starts_at: "2026-03-10T09:00:00Z",
      ends_at: "2026-03-10T10:00:00Z",
      attendee_ids: [first],
    })
    expect(created.statusCode).toBe(201)
    const eventId = (created.json() as { id: string }).id

    const firstBell = await bell(caller(app, first), 1)
    expect(firstBell).toHaveLength(1)
    expect(firstBell[0]).toMatch(/invited you to Planning/)

    const edited = await organiser("PUT", `/api/calendar/${eventId}`, { attendee_ids: [first, second] })
    expect(edited.statusCode).toBe(200)
    expect(await bell(caller(app, second), 1)).toEqual([expect.stringMatching(/invited you to Planning/)])
    expect(await bell(caller(app, first), 2)).toHaveLength(1)
    expect(await bell(organiser, 1)).toEqual([])
  })
})
