import { and, asc, eq, inArray } from "drizzle-orm"
import { db, groupChats, groupChatMembers, organizationMembers, projectMembers, projects, type Tx } from "../db"
import { dropCallAccess, keepAnAdmin } from "./chats"

/** Joins a project member to their membership of the project's organization */
function inOrg(organizationId: string) {
  return and(eq(organizationMembers.userId, projectMembers.userId), eq(organizationMembers.organizationId, organizationId))
}

/** Locks the project row, so concurrent calls for one project create a single chat. */
export async function ensureProjectChat(projectId: string, tx?: Tx): Promise<string> {
  if (!tx) return db.transaction((t) => ensureProjectChat(projectId, t))

  // trash: a project in Trash keeps its chat, which member changes still keep in step
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update")
  if (!project) throw new Error(`Project ${projectId} not found`)

  const [linked] = await tx
    .select({ id: groupChats.id })
    .from(groupChats)
    .where(eq(groupChats.projectId, projectId))
    .orderBy(asc(groupChats.createdAt))
    .limit(1)
  if (linked) return linked.id

  const members = await tx
    .select({ userId: projectMembers.userId, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(organizationMembers, inOrg(project.organizationId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(projectMembers.createdAt))

  const userIds = [...new Set(members.map((m) => m.userId))]
  const ownerId =
    userIds.find((userId) => userId === project.createdBy) ??
    members.find((m) => m.role === "admin")?.userId ??
    userIds[0] ??
    project.createdBy
  if (!ownerId) throw new Error(`Project ${projectId} has no one to own its chat`)

  const now = new Date().toISOString()
  const [chat] = await tx
    .insert(groupChats)
    .values({
      name: project.name,
      organizationId: project.organizationId,
      createdBy: ownerId,
      projectId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: groupChats.id })

  if (userIds.length > 0) {
    await tx.insert(groupChatMembers).values(
      userIds.map((userId) => ({
        groupChatId: chat.id,
        userId,
        role: userId === ownerId ? "admin" : "member",
        joinedAt: now,
      })),
    )
  }

  return chat.id
}

type ChatSync = { added: string[]; removed: string[] }

/** Matches the chat to the project's member rows. The caller pushes `chatsChanged` to both lists after commit. */
export async function syncProjectChatMembers(projectId: string, tx?: Tx): Promise<ChatSync> {
  if (!tx) return db.transaction((t) => syncProjectChatMembers(projectId, t))

  const chatId = await ensureProjectChat(projectId, tx)
  const [chat] = await tx.select({ createdBy: groupChats.createdBy }).from(groupChats).where(eq(groupChats.id, chatId)).for("update")

  // trash: member changes reach a project in Trash too
  const [project] = await tx.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId))
  // Only users still in the organization are seated, so a stale project row never keeps a chat place
  const members = project
    ? await tx
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .innerJoin(organizationMembers, inOrg(project.organizationId))
        .where(eq(projectMembers.projectId, projectId))
    : []
  const chatMembers = await tx
    .select({ id: groupChatMembers.id, userId: groupChatMembers.userId })
    .from(groupChatMembers)
    .where(eq(groupChatMembers.groupChatId, chatId))

  const wanted = new Set(members.map((m) => m.userId))
  const present = new Set(chatMembers.map((m) => m.userId))
  const toAdd = [...wanted].filter((userId) => !present.has(userId))
  const toRemove = chatMembers.filter((m) => !wanted.has(m.userId))

  if (toAdd.length > 0) {
    const now = new Date().toISOString()
    await tx.insert(groupChatMembers).values(
      toAdd.map((userId) => ({
        groupChatId: chatId,
        userId,
        role: userId === chat.createdBy ? "admin" : "member",
        joinedAt: now,
      })),
    )
  }

  if (toRemove.length > 0) {
    await dropCallAccess(
      toRemove.map((m) => m.userId),
      [chatId],
      tx,
    )
    await tx.delete(groupChatMembers).where(
      inArray(
        groupChatMembers.id,
        toRemove.map((m) => m.id),
      ),
    )
  }

  await keepAnAdmin(chatId, tx)
  return { added: toAdd, removed: [...new Set(toRemove.map((m) => m.userId))] }
}
