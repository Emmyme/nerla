import { eq, inArray } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { db, projectMembers, projects, timeEntries } from "../db"
import { makeProject, makeTask, makeUser, makeWorkspace } from "../test/factories"
import { TimeRefusal, type TimeViewer } from "./timeEntries"
import { MAX_REPORT_ENTRIES, setTimeLocks, timeReport, timeReportCsv, type ReportFilters } from "./timeReports"

const MAY: ReportFilters = { from: "2026-05-01", to: "2026-05-31", groupBy: "project" }

let orgId: string
let workspaceAdmin: TimeViewer
let projectAdmin: TimeViewer
let otherAdmin: TimeViewer
let member: TimeViewer
let site: string
let mobile: string
let trashed: string
let foreign: string
let task: string

const viewer = (userId: string, isOrgAdmin = false): TimeViewer => ({ userId, organizationId: orgId, isOrgAdmin })
const refusal = (run: () => Promise<unknown>) =>
  run().then(
    () => null,
    (error: unknown) => (error instanceof TimeRefusal ? error.code : error),
  )

beforeAll(async () => {
  const home = await makeWorkspace()
  orgId = home.orgId
  workspaceAdmin = viewer(home.adminId, true)
  projectAdmin = viewer(await makeUser(orgId))
  otherAdmin = viewer(await makeUser(orgId))
  member = viewer(await makeUser(orgId))
  site = await makeProject(orgId, projectAdmin.userId, { private: true })
  mobile = await makeProject(orgId, otherAdmin.userId, { private: true })
  trashed = await makeProject(orgId, workspaceAdmin.userId, { private: true })
  await db.update(projects).set({ name: "Website" }).where(eq(projects.id, site))
  await db.update(projects).set({ deletedAt: new Date().toISOString() }).where(eq(projects.id, trashed))
  await db.insert(projectMembers).values([
    { projectId: site, userId: member.userId },
    { projectId: site, userId: otherAdmin.userId },
    { projectId: mobile, userId: member.userId },
  ])
  task = await makeTask(orgId, { projectId: site, title: "Header" })
  const away = await makeWorkspace()
  foreign = await makeProject(away.orgId, away.adminId)

  const entry = (userId: string, projectId: string | null, date: string, minutes: number, extra: object = {}) => ({
    organizationId: orgId,
    userId,
    projectId,
    date,
    minutes,
    source: "manual",
    ...extra,
  })
  await db
    .insert(timeEntries)
    .values([
      entry(member.userId, site, "2026-05-04", 60, { taskId: task }),
      entry(member.userId, site, "2026-05-05", 30),
      entry(projectAdmin.userId, site, "2026-05-12", 45, { taskId: task }),
      entry(projectAdmin.userId, site, "2026-05-31", 10),
      entry(member.userId, mobile, "2026-05-06", 90),
      entry(member.userId, null, "2026-05-07", 120, { note: "Personal" }),
      entry(member.userId, null, "2026-05-08", 15, { projectName: "Old site", detachedAt: "2026-05-20 00:00:00" }),
      entry(member.userId, site, "2026-05-09", 0, { source: "auto" }),
      entry(member.userId, site, "2026-04-30", 500),
      { ...entry(away.adminId, foreign, "2026-05-04", 999), organizationId: away.orgId },
    ])
})

describe("time reports", () => {
  it("total a project admin's own projects, grouped by project, person or task", async () => {
    const byProject = await timeReport(projectAdmin, MAY)
    expect(byProject.minutes).toBe(145)
    expect(byProject.groups).toEqual([{ id: site, label: "Website", minutes: 145 }])
    expect(byProject.entries.map((row) => row.date)).toEqual(["2026-05-04", "2026-05-05", "2026-05-12", "2026-05-31"])

    const byPerson = await timeReport(projectAdmin, { ...MAY, groupBy: "person" })
    expect(byPerson.groups.map((group) => [group.id, group.minutes])).toEqual([
      [member.userId, 90],
      [projectAdmin.userId, 55],
    ])

    const byTask = await timeReport(projectAdmin, { ...MAY, groupBy: "task" })
    expect(byTask.groups.map((group) => [group.label, group.minutes])).toEqual([
      ["Header", 105],
      ["No task", 40],
    ])
  })

  it("give a workspace admin every project and detached time, and nobody personal time", async () => {
    const report = await timeReport(workspaceAdmin, MAY)
    expect(report.minutes).toBe(145 + 90 + 15)
    expect(report.groups.map((group) => [group.label, group.minutes])).toEqual([
      ["Website", 145],
      [expect.any(String), 90],
      ["Deleted project: Old site", 15],
    ])
    expect(report.entries.some((row) => row.note === "Personal")).toBe(false)
  })

  it("filter by person and project", async () => {
    const report = await timeReport(workspaceAdmin, { ...MAY, people: [projectAdmin.userId], projects: [site] })
    expect(report.minutes).toBe(55)
  })

  it("are refused to a user who admins no project", async () => {
    expect(await refusal(() => timeReport(member, MAY))).toBe(404)
  })

  it("say when the entries were cut, and still total all of them", async () => {
    const big = await makeWorkspace()
    const project = await makeProject(big.orgId, big.adminId)
    const rows = Array.from({ length: MAX_REPORT_ENTRIES + 1 }, () => ({
      organizationId: big.orgId,
      userId: big.adminId,
      projectId: project,
      date: "2026-05-04",
      minutes: 1,
      source: "manual",
    }))
    await db.insert(timeEntries).values(rows)
    const report = await timeReport({ userId: big.adminId, organizationId: big.orgId, isOrgAdmin: true }, MAY)
    expect([report.truncated, report.entries.length, report.minutes]).toEqual([true, MAX_REPORT_ENTRIES, MAX_REPORT_ENTRIES + 1])
  })

  it("export every entry in the scope as CSV, a week at a time and in date order", async () => {
    let csv = ""
    for await (const chunk of await timeReportCsv(projectAdmin, MAY)) csv += chunk
    const lines = csv.split("\r\n").filter(Boolean)
    expect(lines[0]).toBe("﻿Date,Person,Email,Project,Task ID,Task,Hours,Minutes,Note,Source")
    expect(lines.slice(1).map((line) => line.split(",")[0])).toEqual(["2026-05-04", "2026-05-05", "2026-05-12", "2026-05-31"])
    expect(lines[3]).toContain(",Website,,Header,0.75,45,,manual")
    expect(lines[1]).toContain(",Header,1,60,")
    expect(lines[4]).toContain(",0.1667,10,")
  })
})

describe("lock dates", () => {
  const lockOf = async (projectId: string) =>
    (await db.select({ until: projects.timeLockedUntil }).from(projects).where(eq(projects.id, projectId)))[0].until

  it("let a project admin lock their own project and nothing else", async () => {
    await setTimeLocks(projectAdmin, [site], "2026-05-15")
    expect(await lockOf(site)).toBe("2026-05-15")
    expect(await refusal(() => setTimeLocks(projectAdmin, [mobile], "2026-05-15"))).toBe(404)
    expect(await refusal(() => setTimeLocks(otherAdmin, [site], "2026-05-20"))).toBe(403)
    expect(await refusal(() => setTimeLocks(member, [site], "2026-05-20"))).toBe(404)
    expect(await lockOf(site)).toBe("2026-05-15")
  })

  it("let only a workspace admin lock every project, live ones in their own workspace", async () => {
    expect(await refusal(() => setTimeLocks(projectAdmin, "all", "2026-05-20"))).toBe(403)
    await setTimeLocks(workspaceAdmin, "all", "2026-05-20")
    const rows = await db
      .select({ id: projects.id, until: projects.timeLockedUntil })
      .from(projects)
      .where(inArray(projects.id, [site, mobile, trashed, foreign]))
    expect(Object.fromEntries(rows.map((row) => [row.id, row.until]))).toEqual({
      [site]: "2026-05-20",
      [mobile]: "2026-05-20",
      [trashed]: null,
      [foreign]: null,
    })
  })
})
