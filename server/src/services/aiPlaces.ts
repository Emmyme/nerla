import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm"
import {
  db,
  docCallShares,
  docComments,
  groupChatMembers,
  groupChats,
  messages,
  organizationMembers,
  projects,
  taskComments,
  tasks,
  users,
} from "../db"
import { fitContext, untrusted } from "../utils/aiPrompt"
import type { Place, Via } from "../utils/aiTypes"
import { canSeeComments } from "../utils/docAccess"
import { boardLines } from "../utils/docText"
import { BOARD_FIELD } from "../utils/docYjs"
import { renderMentions } from "../utils/mentions"
import { localMinute } from "../utils/eventTime"
import { presenceName } from "../utils/presence"
import { taskAccessLevel } from "../utils/taskAccess"
import { liveProject, liveTask } from "../utils/trash"
import { workspaceAi } from "./aiSettings"
import { docLevelFor, docPeople, findDoc } from "./docs"
import { paperText } from "./docRefs"
import { currentDoc } from "./docWrite"
import { mentionNames } from "./mentions"

/** Above this many users the AI answers from the place alone, with no tools */
const LARGE_PLACE = 100

const RECENT = 30
const TEXT_MAX = 8000
/** One message or comment, and the whole place, so a long thread can't flood every model call */
const SAID_MAX = 2000
const CONTEXT_MAX = 12000

const cut = (text: string) => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}\n(cut off)` : text)

async function adminIds(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.role, "admin")))
  return rows.map((row) => row.userId)
}

async function groupAudience(groupId: string, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: groupChatMembers.userId })
    .from(groupChatMembers)
    .innerJoin(groupChats, eq(groupChats.id, groupChatMembers.groupChatId))
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.userId, groupChatMembers.userId), eq(organizationMembers.organizationId, organizationId)),
    )
    .where(and(eq(groupChatMembers.groupChatId, groupId), eq(groupChats.organizationId, organizationId)))
  return rows.map((row) => row.userId)
}

const loadTask = (taskId: string, organizationId: string) =>
  db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId), liveTask),
    with: { project: { with: { members: { columns: { userId: true } } } } },
  })

/** Everyone who can read the task, by the same rule its routes use */
async function taskAudience(taskId: string, organizationId: string): Promise<string[]> {
  const task = await loadTask(taskId, organizationId)
  if (!task) return []
  const admins = new Set(await adminIds(organizationId))
  const candidates = task.projectId ? [...(task.project?.members.map((member) => member.userId) ?? []), ...admins] : [task.assignedTo]
  const inWorkspace = await membersIn(
    organizationId,
    candidates.filter((id): id is string => !!id),
  )
  return [...inWorkspace].filter((userId) => taskAccessLevel(task, userId, organizationId, admins.has(userId)) !== null)
}

async function membersIn(organizationId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), inArray(organizationMembers.userId, [...new Set(ids)])))
  return new Set(rows.map((row) => row.userId))
}

/** Everyone with comment level or higher on the doc */
async function docAudience(fileId: string, organizationId: string): Promise<string[]> {
  const file = await findDoc(fileId, organizationId)
  if (!file) return []
  const admins = new Set(await adminIds(organizationId))
  const people = (await docPeople(file, organizationId)).map((person) => person.id)
  const candidates = [...new Set([...people, ...(file.projectId ? admins : [])])]
  const levels = await Promise.all(
    candidates.map(async (userId) => (await docLevelFor(fileId, { userId, organizationId, isOrgAdmin: admins.has(userId) })).level),
  )
  return candidates.filter((_userId, index) => canSeeComments(levels[index]))
}

/** An open call share at comment level or above lets call guests and share members read the comments too */
async function callShared(fileId: string, organizationId: string): Promise<boolean> {
  const [share] = await db
    .select({ id: docCallShares.id })
    .from(docCallShares)
    .where(
      and(
        eq(docCallShares.fileId, fileId),
        eq(docCallShares.organizationId, organizationId),
        isNull(docCallShares.closedAt),
        inArray(docCallShares.level, ["comment", "edit"]),
      ),
    )
    .limit(1)
  return !!share
}

/** Too big for lookups, or read by call guests the audience can't name, so the AI answers from the place alone */
export async function placeIsLarge(place: Place, organizationId: string, audience: string[]): Promise<boolean> {
  if (audience.length > LARGE_PLACE) return true
  return place.kind === "doc_comment" && (await callShared(place.fileId, organizationId))
}

/** Everyone who reads what the AI says in the place. A DM or MCP session has nobody else */
export async function placeAudience(place: Place, organizationId: string): Promise<string[]> {
  switch (place.kind) {
    case "group":
      return [...new Set(await groupAudience(place.id, organizationId))]
    case "task_comment":
      return [...new Set(await taskAudience(place.taskId, organizationId))]
    case "doc_comment":
      return [...new Set(await docAudience(place.fileId, organizationId))]
    default:
      return []
  }
}

type Said = { userId: string | null; name: string | null; text: string; at: string; via: Via | null }

async function namesById(organizationId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .innerJoin(organizationMembers, and(eq(organizationMembers.userId, users.id), eq(organizationMembers.organizationId, organizationId)))
    .where(inArray(users.id, unique))
  return new Map(rows.map((row) => [row.id, presenceName(row.firstName, row.lastName)]))
}

/** Each message as its own untrusted block, named by who said it. What the AI said goes under its own name */
async function saidBlocks(organizationId: string, aiName: string, zone: string, said: Said[], what: string): Promise<string[]> {
  const [people, mentioned] = await Promise.all([
    namesById(
      organizationId,
      said.flatMap((row) => (row.userId ? [row.userId] : [])),
    ),
    mentionNames(
      organizationId,
      said.map((row) => row.text),
    ),
  ])
  return said.map((row) => {
    const byAi = row.via?.kind === "ai" && row.via.speaker === "ai"
    const who = byAi ? aiName : (row.name ?? (row.userId ? people.get(row.userId) : null) ?? "Someone")
    const text = renderMentions(row.text, mentioned).replace(/@\[ai\]/gi, `@${aiName}`)
    const shown = text.length > SAID_MAX ? `${text.slice(0, SAID_MAX)}\n(cut off)` : text
    return untrusted(`${what} by ${who} at ${localMinute(row.at, zone)}`, shown)
  })
}

async function projectBlock(projectId: string | null, organizationId: string): Promise<string[]> {
  if (!projectId) return []
  const [row] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId), liveProject))
    .limit(1)
  return row ? [untrusted("project name", row.name)] : []
}

type Blocks = { fixed: string[]; said: string[] }
const NONE: Blocks = { fixed: [], said: [] }

async function groupContext(groupId: string, organizationId: string, aiName: string, zone: string): Promise<Blocks> {
  const [chat] = await db
    .select({ name: groupChats.name, projectId: groupChats.projectId })
    .from(groupChats)
    .where(and(eq(groupChats.id, groupId), eq(groupChats.organizationId, organizationId)))
    .limit(1)
  if (!chat) return NONE
  const rows = await db
    .select({ userId: messages.senderId, text: messages.content, at: messages.createdAt, via: messages.doneVia })
    .from(messages)
    .where(
      and(
        eq(messages.threadType, "group"),
        eq(messages.threadId, groupId),
        eq(messages.organizationId, organizationId),
        eq(messages.kind, "text"),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(RECENT)
  const said = rows.reverse().map((row) => ({ ...row, name: null }))
  return {
    fixed: [untrusted("chat name", chat.name), ...(await projectBlock(chat.projectId, organizationId))],
    said: await saidBlocks(organizationId, aiName, zone, said, "chat message"),
  }
}

async function taskContext(taskId: string, organizationId: string, aiName: string, zone: string): Promise<Blocks> {
  const task = await loadTask(taskId, organizationId)
  if (!task) return NONE
  const rows = await db
    .select({ userId: taskComments.userId, text: taskComments.content, at: taskComments.createdAt, via: taskComments.doneVia })
    .from(taskComments)
    .where(and(eq(taskComments.taskId, taskId), eq(taskComments.organizationId, organizationId)))
    .orderBy(desc(taskComments.createdAt), desc(taskComments.id))
    .limit(RECENT)
  const said = rows.reverse().map((row) => ({ ...row, name: null }))
  return {
    fixed: [
      ...(await projectBlock(task.projectId, organizationId)),
      untrusted("task title", task.title),
      ...(task.description ? [untrusted("task description", cut(task.description))] : []),
    ],
    said: await saidBlocks(organizationId, aiName, zone, said, "task comment"),
  }
}

async function docContext(fileId: string, commentId: string, organizationId: string, aiName: string, zone: string): Promise<Blocks> {
  const file = await findDoc(fileId, organizationId)
  if (!file || file.deletedAt) return NONE
  const doc = await currentDoc(file, organizationId)
  let text: string
  try {
    text = file.docType === "board" ? boardLines(doc.getMap<unknown>(BOARD_FIELD)) : await paperText(doc, organizationId, null)
  } finally {
    doc.destroy()
  }
  const rows = await db
    .select({
      userId: docComments.authorId,
      guestName: docComments.guestName,
      text: docComments.body,
      at: docComments.createdAt,
      via: docComments.doneVia,
    })
    .from(docComments)
    .where(
      and(
        eq(docComments.organizationId, organizationId),
        eq(docComments.fileId, fileId),
        isNull(docComments.deletedAt),
        or(eq(docComments.id, commentId), eq(docComments.parentId, commentId)),
      ),
    )
    .orderBy(asc(docComments.createdAt), asc(docComments.id))
  const said = rows.slice(-RECENT).map((row) => ({ ...row, name: row.userId ? null : row.guestName }))
  return {
    fixed: [
      ...(await projectBlock(file.projectId, organizationId)),
      untrusted(`${file.docType} name`, file.fileName),
      untrusted(`${file.docType} text`, cut(text)),
    ],
    said: await saidBlocks(organizationId, aiName, zone, said, "comment"),
  }
}

/**
 * What the place holds that everyone in it can see, each piece as untrusted data. Times show as wall clock minutes
 * in `zone`, the asker's, the way read_chat shows them
 */
export async function placeContext(place: Place, organizationId: string, zone: string): Promise<string> {
  const aiName = (await workspaceAi(organizationId))?.name ?? "Nerla AI"
  let blocks = NONE
  if (place.kind === "group") blocks = await groupContext(place.id, organizationId, aiName, zone)
  else if (place.kind === "task_comment") blocks = await taskContext(place.taskId, organizationId, aiName, zone)
  else if (place.kind === "doc_comment") blocks = await docContext(place.fileId, place.commentId, organizationId, aiName, zone)
  return fitContext(blocks.fixed, blocks.said, CONTEXT_MAX)
}

/** What the asker calls the place, for a card only they see */
export async function placeName(place: Place, organizationId: string): Promise<string> {
  if (place.kind === "group") {
    const [chat] = await db
      .select({ name: groupChats.name })
      .from(groupChats)
      .where(and(eq(groupChats.id, place.id), eq(groupChats.organizationId, organizationId)))
      .limit(1)
    return chat?.name ?? "the group chat"
  }
  if (place.kind === "task_comment") {
    const task = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, place.taskId), eq(tasks.organizationId, organizationId), liveTask),
      columns: { title: true },
    })
    return task ? `the comments on ${task.title}` : "the task's comments"
  }
  if (place.kind === "doc_comment") {
    const file = await findDoc(place.fileId, organizationId)
    return file ? `the comments on ${file.fileName}` : "the paper's comments"
  }
  return "your DM"
}
