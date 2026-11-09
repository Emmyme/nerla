import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm"
import { db, groupChats, projectMembers, tasks, users } from "../db"
import type { projects } from "../db/schema"
import { liveTask } from "./trash"

type ProjectRow = typeof projects.$inferSelect

type ProjectMemberSummary = {
  id: string
  first_name: string | null
  last_name: string | null
  avatar_url: string | null
}

type ProjectExtras = {
  taskCount: number
  doneCount: number
  nextDue: string | null
  members: ProjectMemberSummary[]
  chatId: string | null
}

export function toProjectDto(project: ProjectRow, extras: ProjectExtras) {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    key: project.key,
    color: project.color,
    icon: project.icon,
    description: project.description,
    status: project.status,
    created_by: project.createdBy,
    created_via: project.createdVia,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    task_count: extras.taskCount,
    done_count: extras.doneCount,
    next_due: extras.nextDue,
    members: extras.members,
    chat_id: extras.chatId,
  }
}

export async function loadProjectDtos(rows: ProjectRow[]) {
  if (rows.length === 0) return []
  const ids = rows.map((p) => p.id)

  const [counts, memberRows, chatRows] = await Promise.all([
    db
      .select({
        projectId: tasks.projectId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
        nextDue: sql<string | null>`min(${tasks.dueDate}) filter (where ${tasks.status} in ('todo', 'in_progress'))`,
      })
      .from(tasks)
      .where(and(inArray(tasks.projectId, ids), ne(tasks.status, "cancelled"), liveTask))
      .groupBy(tasks.projectId),
    db
      .select({
        projectId: projectMembers.projectId,
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        avatarUrl: users.avatarUrl,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(inArray(projectMembers.projectId, ids))
      .orderBy(projectMembers.createdAt),
    db
      .select({ projectId: groupChats.projectId, id: groupChats.id })
      .from(groupChats)
      .where(and(isNotNull(groupChats.projectId), inArray(groupChats.projectId, ids)))
      .orderBy(groupChats.createdAt),
  ])

  const countsByProject = new Map(counts.map((c) => [c.projectId, c]))
  const membersByProject = new Map<string, ProjectMemberSummary[]>()
  for (const m of memberRows) {
    const list = membersByProject.get(m.projectId) ?? []
    list.push({
      id: m.id,
      first_name: m.firstName,
      last_name: m.lastName,
      avatar_url: m.avatarUrl,
    })
    membersByProject.set(m.projectId, list)
  }
  const chatByProject = new Map<string, string>()
  for (const c of chatRows) {
    if (c.projectId && !chatByProject.has(c.projectId)) chatByProject.set(c.projectId, c.id)
  }

  return rows.map((project) => {
    const c = countsByProject.get(project.id)
    return toProjectDto(project, {
      taskCount: c?.total ?? 0,
      doneCount: c?.done ?? 0,
      nextDue: c?.nextDue ?? null,
      members: membersByProject.get(project.id) ?? [],
      chatId: chatByProject.get(project.id) ?? null,
    })
  })
}

export async function loadProjectDto(row: ProjectRow) {
  const [dto] = await loadProjectDtos([row])
  return dto
}
