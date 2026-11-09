import type { FastifyReply, FastifyRequest } from "fastify"
import { and, eq, inArray, sql } from "drizzle-orm"
import { db, organizationMembers, organizations, users, type Executor } from "../db"
import { isRefusal, pickOrg, refusalMessages, type OrgContext, type OrgRefusal } from "../utils/tenancy"

/** The only place that reads a caller's memberships by user alone */
export async function resolveOrg(userId: string, executor: Executor = db): Promise<OrgContext | OrgRefusal> {
  const memberships = await executor
    .select({ organizationId: organizationMembers.organizationId, role: organizationMembers.role })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
  return pickOrg(memberships)
}

/** `resolveOrg` for many users in one query */
export async function resolveOrgs(userIds: string[], executor: Executor = db): Promise<Map<string, OrgContext | OrgRefusal>> {
  const unique = [...new Set(userIds)]
  const rows = unique.length
    ? await executor
        .select({ userId: organizationMembers.userId, organizationId: organizationMembers.organizationId, role: organizationMembers.role })
        .from(organizationMembers)
        .where(inArray(organizationMembers.userId, unique))
    : []
  const byUser = new Map<string, typeof rows>()
  for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row])
  return new Map(unique.map((userId) => [userId, pickOrg(byUser.get(userId) ?? [])]))
}

/** The workspace orgMiddleware resolved, failing loudly on a route that never ran it */
export function orgOf(request: FastifyRequest): OrgContext {
  if (!request.org) throw new Error("orgMiddleware did not run for this route")
  return request.org
}

/** The signed-in user as a member of the workspace orgMiddleware resolved */
export function viewerFor(request: FastifyRequest) {
  const org = orgOf(request)
  return { userId: request.user.id, organizationId: org.organizationId, isOrgAdmin: org.role === "admin" }
}

function refuse(reply: FastifyReply, refusal: OrgRefusal) {
  return reply.status(refusal.status).send({ error: refusalMessages[refusal.error], code: refusal.error })
}

/** Runs after authMiddleware and sets `request.org` */
export async function orgMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const org = await resolveOrg(request.user.id)
  if (isRefusal(org)) return refuse(reply, org)
  request.org = org
}

export async function orgAdminMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const org = await resolveOrg(request.user.id)
  if (isRefusal(org)) return refuse(reply, org)
  if (org.role !== "admin") return reply.status(403).send({ error: "Only workspace admins can do this", code: "not-an-admin" })
  request.org = org
}

/** Runs after orgMiddleware. Users who are not workspace admins get the 404 a missing page gets */
export async function adminOnly(request: FastifyRequest, reply: FastifyReply) {
  if (orgOf(request).role !== "admin") return reply.code(404).send({ error: "Not found" })
}

export async function isMemberOf(userId: string, organizationId: string, executor: Executor = db): Promise<boolean> {
  const [row] = await executor
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, organizationId)))
    .limit(1)
  return !!row
}

/** Whether the account belongs to any workspace */
export async function hasMembership(userId: string, executor: Executor = db): Promise<boolean> {
  const [row] = await executor
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .limit(1)
  return !!row
}

/** A condition for queries on `users`: the account belongs to no workspace */
export const holdsNoMembership = () =>
  sql`not exists (select 1 from ${organizationMembers} where ${organizationMembers.userId} = ${users.id})`

/** The ids among `userIds` that belong to the organization */
export async function membersOf(organizationId: string, userIds: string[], executor: Executor = db): Promise<Set<string>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Set()
  const rows = await executor
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), inArray(organizationMembers.userId, unique)))
  return new Set(rows.map((row) => row.userId))
}

/** The ids among `ids` that are not members of the organization */
export async function outsiders(organizationId: string, ids: string[]): Promise<string[]> {
  const members = await membersOf(organizationId, ids)
  return [...new Set(ids)].filter((id) => !members.has(id))
}

/** Every member's id, as a subquery for `inArray` */
export const memberIdsOf = (organizationId: string) =>
  db.select({ id: organizationMembers.userId }).from(organizationMembers).where(eq(organizationMembers.organizationId, organizationId))

export async function orgMemberIds(organizationId: string): Promise<string[]> {
  const rows = await memberIdsOf(organizationId)
  return [...new Set(rows.map((row) => row.id))]
}

/** The server's organization while it has exactly one, else null */
export async function soleOrganizationId(executor: Executor = db): Promise<string | null> {
  const rows = await executor.select({ id: organizations.id }).from(organizations).limit(2)
  return rows.length === 1 ? rows[0].id : null
}
