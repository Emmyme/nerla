import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { eventRoomAccess, eventRoomHosts, saveSharing } from "../services/calendarQueries"
import { caller, testApp } from "../test/app"
import { makeEvent, makeUser, makeWorkspace } from "../test/factories"
import type { GrantLevel, ShareLevel } from "../utils/eventVisibility"

type Seen = "full" | "busy" | "hidden"
type Viewer = "organiser" | "guest" | "coworker" | "admin" | "outsider"

const DAY = { start: "2026-03-10T00:00:00Z", end: "2026-03-11T00:00:00Z" }
const VIEWERS: Viewer[] = ["organiser", "guest", "coworker", "admin", "outsider"]

let app: FastifyInstance
let orgId: string
const ids = {} as Record<Viewer, string>
const as = {} as Record<Viewer, ReturnType<typeof caller>>
let meeting: string
let focus: string

const seenOf = (status: number, body: { busy?: boolean; title?: string }): Seen =>
  status === 404 ? "hidden" : body.busy ? "busy" : body.title ? "full" : "hidden"

/** How the viewer sees an event opened on a calendar, by its own route */
async function opened(viewer: Viewer, eventId: string, calendar?: string): Promise<Seen> {
  const res = await as[viewer]("GET", `/api/calendar/${eventId}${calendar ? `?calendar=${calendar}` : ""}`)
  return seenOf(res.statusCode, res.json())
}

/** How the viewer sees the meeting and the focus block in a user's Team view column, if the column shows */
async function inTeam(viewer: Viewer, person: string): Promise<{ column: boolean; meeting: Seen; focus: Seen }> {
  const res = await as[viewer]("GET", `/api/calendar/team?users=${person}&start=${DAY.start}&end=${DAY.end}`)
  expect(res.statusCode).toBe(200)
  const column = (res.json() as Record<string, { starts_at: string; busy?: boolean }[]>)[person]
  const at = (time: string): Seen => {
    const event = column?.find((item) => item.starts_at.startsWith(`2026-03-10T${time}`))
    return !event ? "hidden" : event.busy ? "busy" : "full"
  }
  return { column: !!column, meeting: at("09:00"), focus: at("13:00") }
}

const share = (level: ShareLevel, grants: { grantee_id: string; level: GrantLevel }[] = []) =>
  saveSharing(ids.organiser, orgId, { default_level: level, grants })

beforeAll(async () => {
  app = await testApp()
  const home = await makeWorkspace()
  orgId = home.orgId
  ids.admin = home.adminId
  ids.organiser = await makeUser(orgId)
  ids.guest = await makeUser(orgId)
  ids.coworker = await makeUser(orgId)
  ids.outsider = (await makeWorkspace()).adminId
  for (const viewer of VIEWERS) as[viewer] = caller(app, ids[viewer])
  meeting = await makeEvent(orgId, ids.organiser, {
    title: "Planning",
    startsAt: "2026-03-10T09:00:00Z",
    endsAt: "2026-03-10T10:00:00Z",
    guests: [ids.guest],
  })
  focus = await makeEvent(orgId, ids.organiser, {
    title: "Deep work",
    startsAt: "2026-03-10T13:00:00Z",
    endsAt: "2026-03-10T15:00:00Z",
    eventType: "focus",
    guests: [ids.guest],
  })
})

afterAll(() => app.close())

describe("who sees the organiser's events", () => {
  const CASES: {
    sharing: string
    level: ShareLevel
    grant?: GrantLevel
    coworker: [Seen, Seen]
    admin: [Seen, Seen]
  }[] = [
    { sharing: "details, the default", level: "details", coworker: ["full", "busy"], admin: ["full", "busy"] },
    { sharing: "busy", level: "busy", coworker: ["busy", "busy"], admin: ["busy", "busy"] },
    { sharing: "private", level: "private", coworker: ["hidden", "hidden"], admin: ["hidden", "hidden"] },
    { sharing: "private with a busy grant", level: "private", grant: "busy", coworker: ["busy", "busy"], admin: ["hidden", "hidden"] },
    {
      sharing: "private with an everything grant",
      level: "private",
      grant: "everything",
      coworker: ["full", "full"],
      admin: ["hidden", "hidden"],
    },
    {
      sharing: "details with an everything grant",
      level: "details",
      grant: "everything",
      coworker: ["full", "full"],
      admin: ["full", "busy"],
    },
  ]

  it.each(CASES)("sharing $sharing", async ({ level, grant, coworker, admin }) => {
    await share(level, grant ? [{ grantee_id: ids.coworker, level: grant }] : [])
    const expected: Record<Viewer, [Seen, Seen]> = {
      organiser: ["full", "full"],
      guest: ["full", "full"],
      coworker,
      admin,
      outsider: ["hidden", "hidden"],
    }
    const seen = {} as Record<Viewer, [Seen, Seen]>
    for (const viewer of VIEWERS) seen[viewer] = [await opened(viewer, meeting), await opened(viewer, focus)]
    expect(seen).toEqual(expected)

    for (const viewer of ["coworker", "admin"] as const) {
      const team = await inTeam(viewer, ids.organiser)
      const listed = expected[viewer].some((value) => value !== "hidden")
      expect({ column: team.column, events: listed ? [team.meeting, team.focus] : null }).toEqual({
        column: listed,
        events: listed ? expected[viewer] : null,
      })
    }
  })

  it("never lists anyone from another workspace in Team view", async () => {
    await share("details")
    const res = await as.outsider("GET", `/api/calendar/team?users=${ids.organiser}&start=${DAY.start}&end=${DAY.end}`)
    expect(res.json()).toEqual({})
  })

  it("shows an Everyone event in full to every member, whatever the sharing, and never outside the workspace", async () => {
    await share("private")
    const allHands = await makeEvent(orgId, ids.organiser, {
      title: "All hands",
      startsAt: "2026-03-10T16:00:00Z",
      endsAt: "2026-03-10T17:00:00Z",
      everyone: true,
    })
    const seen = await Promise.all(VIEWERS.map((viewer) => opened(viewer, allHands)))
    expect(seen).toEqual(["full", "full", "full", "full", "hidden"])
  })
})

describe("an event on a guest's calendar", () => {
  it("shows no more than the guest's own sharing allows", async () => {
    await share("details")
    await saveSharing(ids.guest, orgId, { default_level: "busy", grants: [] })
    expect(await opened("coworker", meeting, ids.guest)).toBe("busy")
    expect(await opened("coworker", meeting, ids.organiser)).toBe("full")
  })

  it("shows no more than its organiser allows", async () => {
    await share("private")
    await saveSharing(ids.guest, orgId, { default_level: "details", grants: [] })
    expect(await opened("coworker", meeting, ids.guest)).toBe("hidden")
    const team = await inTeam("coworker", ids.guest)
    expect(team).toEqual({ column: true, meeting: "hidden", focus: "hidden" })
  })
})

describe("series in the range", () => {
  // Their own organiser, so no other test's events land in these ranges
  let planner: ReturnType<typeof caller>
  const range = async (start: string, end: string) =>
    ((await planner("GET", `/api/calendar/range?start=${start}&end=${end}`)).json() as { title: string }[]).map((e) => e.title)

  beforeAll(async () => {
    const plannerId = await makeUser(orgId)
    planner = caller(app, plannerId)
    await makeEvent(orgId, plannerId, {
      title: "Ended in January",
      startsAt: "2026-01-05T09:00:00Z",
      endsAt: "2026-01-05T10:00:00Z",
      recurrenceRule: "FREQ=WEEKLY;UNTIL=20260126T090000Z",
    })
    await makeEvent(orgId, plannerId, {
      title: "Counted",
      startsAt: "2026-06-01T09:00:00Z",
      endsAt: "2026-06-01T10:00:00Z",
      recurrenceRule: "FREQ=DAILY;COUNT=40",
    })
    // Five days long, so the occurrence that starts on its UNTIL date still covers 1 May
    await makeEvent(orgId, plannerId, {
      title: "Long block",
      startsAt: "2026-04-20T09:00:00Z",
      endsAt: "2026-04-25T09:00:00Z",
      recurrenceRule: "FREQ=WEEKLY;UNTIL=20260427T090000Z",
    })
  })

  it("skips a series that ended before the range and keeps one that ends inside it", async () => {
    expect(await range("2026-01-19T00:00:00Z", "2026-01-20T00:00:00Z")).toEqual(["Ended in January"])
    expect(await range("2026-03-02T00:00:00Z", "2026-03-09T00:00:00Z")).toEqual([])
  })

  it("keeps a series with a count, which has no end date to read", async () => {
    expect(await range("2026-07-08T00:00:00Z", "2026-07-09T00:00:00Z")).toEqual(["Counted"])
  })

  it("keeps a long occurrence that started on the series' last day and runs into the range", async () => {
    expect(await range("2026-05-01T00:00:00Z", "2026-05-02T00:00:00Z")).toEqual(["Long block"])
  })
})

describe("the call room of a series", () => {
  it("lets in guests of live rows only, never a user invited only to a cancelled occurrence", async () => {
    const series = await makeEvent(orgId, ids.organiser, {
      startsAt: "2026-03-02T09:00:00Z",
      endsAt: "2026-03-02T10:00:00Z",
      recurrenceRule: "FREQ=WEEKLY;COUNT=4",
      videoCall: true,
      guests: [ids.guest],
    })
    await makeEvent(orgId, ids.organiser, {
      startsAt: "2026-03-09T09:00:00Z",
      endsAt: "2026-03-09T10:00:00Z",
      seriesId: series,
      originalStart: "2026-03-09T09:00:00Z",
      cancelled: true,
      guests: [ids.coworker],
    })

    expect(await eventRoomAccess(ids.guest, orgId, series)).toBe(true)
    expect(await eventRoomAccess(ids.coworker, orgId, series)).toBe(false)
    expect((await eventRoomHosts(series)).hosts.sort()).toEqual([ids.organiser, ids.guest].sort())
    expect(await eventRoomAccess(ids.guest, (await makeWorkspace()).orgId, series)).toBe(false)
  })
})

describe("an event a workspace admin moved to the trash", () => {
  it("shows the admin no title they couldn't see on the calendar", async () => {
    await share("details")
    const hidden = await makeEvent(orgId, ids.organiser, {
      title: "Hidden focus",
      startsAt: "2026-03-12T13:00:00Z",
      endsAt: "2026-03-12T15:00:00Z",
      eventType: "focus",
    })
    expect((await as.admin("DELETE", `/api/calendar/${hidden}`)).statusCode).toBe(200)
    const items = ((await as.admin("GET", "/api/trash?kind=events")).json() as { items: { id: string; name: string }[] }).items
    expect(items.find((item) => item.id === hidden)?.name).toBe("A private event")
  })
})
