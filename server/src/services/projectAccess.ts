import { and, eq, inArray, sql, type SQL } from "drizzle-orm"
import { db, organizationMembers, projectMembers, projectPins, projects, tasks, type Executor, type Tx } from "../db"
import { nextProjectAdmin } from "../utils/projectMembership"
import { liveProject } from "../utils/trash"

export type ProjectAccess = { project: typeof projects.$inferSelect; role: string }

/** One query on the project joined to the caller's own row, so a non-member gets null like a missing project. */
async function accessWhere(userId: string, organizationId: string, match: SQL, executor: Executor): Promise<ProjectAccess | null> {
  const [row] = await executor
    .select({ project: projects, role: projectMembers.role })
    .from(projects)
    .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
    .where(and(match, eq(projects.organizationId, organizationId), liveProject))
    .orderBy(sql`${projectMembers.role} = 'admin' desc`)
    .limit(1)
  return row ?? null
}

/** The role a workspace admin gets on a project they are not a member of. It reads and never writes */
export const ADMIN_VIEWER = "admin-viewer"

/** The project when the caller is an admin of its workspace, as `ADMIN_VIEWER` */
async function adminViewWhere(userId: string, organizationId: string, match: SQL, executor: Executor): Promise<ProjectAccess | null> {
  const [row] = await executor
    .select({ project: projects })
    .from(projects)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, projects.organizationId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.role, "admin"),
      ),
    )
    .where(and(match, eq(projects.organizationId, organizationId), liveProject))
    .limit(1)
  return row ? { project: row.project, role: ADMIN_VIEWER } : null
}

async function readWhere(userId: string, organizationId: string, match: SQL, executor: Executor): Promise<ProjectAccess | null> {
  return (await accessWhere(userId, organizationId, match, executor)) ?? adminViewWhere(userId, organizationId, match, executor)
}

/** For reads only. A member gets their role, a workspace admin outside the project gets `ADMIN_VIEWER` */
export function projectReadAccess(
  userId: string,
  organizationId: string,
  projectId: string,
  executor: Executor = db,
): Promise<ProjectAccess | null> {
  return readWhere(userId, organizationId, eq(projects.id, projectId), executor)
}

export function projectReadAccessBySlug(
  userId: string,
  organizationId: string,
  slug: string,
  executor: Executor = db,
): Promise<ProjectAccess | null> {
  return readWhere(userId, organizationId, eq(projects.slug, slug), executor)
}

/** Ids of the projects the caller may read, for use inside `inArray`: their own, or all of them for a workspace admin */
export const readableProjectIds = (userId: string, organizationId: string) =>
  db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        liveProject,
        sql`(exists (select 1 from ${projectMembers} where ${projectMembers.projectId} = ${projects.id} and ${projectMembers.userId} = ${userId})
          or exists (select 1 from ${organizationMembers} where ${organizationMembers.organizationId} = ${organizationId}
            and ${organizationMembers.userId} = ${userId} and ${organizationMembers.role} = 'admin'))`,
      ),
    )

/** Members only. Every write checks this, so a workspace admin outside the project is refused */
export function projectAccess(
  userId: string,
  organizationId: string,
  projectId: string,
  executor: Executor = db,
): Promise<ProjectAccess | null> {
  return accessWhere(userId, organizationId, eq(projects.id, projectId), executor)
}

/** Ids of the caller's projects in the organization, for use inside `inArray`. */
export const memberProjectIds = (userId: string, organizationId: string) =>
  db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.userId, userId), eq(projects.organizationId, organizationId), liveProject))

/** Loads only the caller's own member row on a project, which is what `canAccessTask` reads. */
export const callerMembership = (userId: string) =>
  ({
    members: {
      where: eq(projectMembers.userId, userId),
      columns: { userId: true },
    },
  }) as const

export async function isProjectMember(projectId: string, userId: string, executor: Executor = db): Promise<boolean> {
  const membership = await executor.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
    columns: { id: true },
  })
  return !!membership
}

/** Takes the project row `FOR UPDATE`, which serializes leaving and role changes on one project. */
export async function lockProject(tx: Tx, projectId: string) {
  // trash: leaving and removals reach a project in Trash too, so no removed user comes back with a restore
  const [project] = await tx
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update")
  return project ?? null
}

/** Member rows of users still in the organization, so a stale row never counts as an admin. */
export function memberRowsInOrg(tx: Tx, projectId: string, organizationId: string) {
  return tx
    .select({
      userId: projectMembers.userId,
      role: projectMembers.role,
      createdAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.userId, projectMembers.userId), eq(organizationMembers.organizationId, organizationId)),
    )
    .where(eq(projectMembers.projectId, projectId))
}

/** Removes users from a project with their pins, unassigns their tasks there and keeps an admin when one is left. */
export async function leaveProject(tx: Tx, projectId: string, userIds: string[]): Promise<void> {
  const [leaver] = userIds
  if (!leaver) return
  const project = await lockProject(tx, projectId)
  if (!project) return

  await tx.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.userId, userIds)))
  await tx
    .delete(projectPins)
    .where(
      and(
        eq(projectPins.projectId, projectId),
        inArray(projectPins.userId, userIds),
        eq(projectPins.organizationId, project.organizationId),
      ),
    )
  await tx
    .update(tasks)
    .set({ assignedTo: null, updatedAt: new Date().toISOString() })
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.assignedTo, userIds)))

  const remaining = await memberRowsInOrg(tx, projectId, project.organizationId)
  const promote = nextProjectAdmin(remaining, leaver)
  if (promote) {
    await tx
      .update(projectMembers)
      .set({ role: "admin" })
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, promote)))
  }
}
