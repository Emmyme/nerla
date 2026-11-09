import { and, eq } from "drizzle-orm"
import { calendarEvents, db, tasks } from "../db"
import { dmPeople } from "../utils/aiPlace"
import type { ItemRef } from "../utils/aiTypes"
import { canSeeComments } from "../utils/docAccess"
import { can } from "../utils/fileAccess"
import { taskAccessLevel } from "../utils/taskAccess"
import { isRefusal } from "../utils/tenancy"
import { liveEvent, liveTask } from "../utils/trash"
import { visibilityOf } from "./calendarQueries"
import { dmAllowed, groupAccess } from "./chats"
import { docLevelFor } from "./docs"
import { loadFileFacts } from "./files"
import { callerMembership, projectReadAccess } from "./projectAccess"
import { membersOf, resolveOrgs } from "./tenancy"

export type ReachViewer = { userId: string; organizationId: string; isOrgAdmin: boolean }

/** Whether the user can open the item, by the same rules the routes use */
export async function canRead(viewer: ReachViewer, ref: ItemRef): Promise<boolean> {
  const { userId, organizationId } = viewer
  switch (ref.kind) {
    case "task": {
      const task = await db.query.tasks.findFirst({
        where: and(eq(tasks.id, ref.id), eq(tasks.organizationId, organizationId), liveTask),
        with: { project: { with: callerMembership(userId) } },
      })
      return !!task && taskAccessLevel(task, userId, organizationId, viewer.isOrgAdmin) !== null
    }
    case "project":
      return !!(await projectReadAccess(userId, organizationId, ref.id))
    case "doc":
      return !!(await docLevelFor(ref.id, viewer)).level
    case "file": {
      const loaded = await loadFileFacts(ref.id, viewer)
      return !!loaded && can("view", loaded.facts, loaded.viewer)
    }
    case "chat": {
      const pair = dmPeople(ref)
      if (!pair) return !!(await groupAccess(organizationId, userId, ref.id))
      if (!pair.includes(userId)) return false
      const [a, b] = pair
      return dmAllowed(organizationId, userId, a === userId ? b : a)
    }
    case "event": {
      const row = await db.query.calendarEvents.findFirst({
        where: and(eq(calendarEvents.id, ref.id), eq(calendarEvents.organizationId, organizationId), liveEvent),
      })
      return !!row && (await visibilityOf({ id: userId, organizationId }, row)) === "full"
    }
    case "person":
      return (await membersOf(organizationId, [ref.id])).has(ref.id)
  }
}

/** Whether every one of the users sees the doc's comments, each with their own rights */
export async function allSeeComments(organizationId: string, userIds: string[], fileId: string): Promise<boolean> {
  const orgs = await resolveOrgs(userIds)
  const seen = await Promise.all(
    userIds.map(async (userId) => {
      const org = orgs.get(userId)
      if (!org || isRefusal(org) || org.organizationId !== organizationId) return false
      return canSeeComments((await docLevelFor(fileId, { userId, organizationId, isOrgAdmin: org.role === "admin" })).level)
    }),
  )
  return seen.every(Boolean)
}
