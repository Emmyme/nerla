/**
 * Builders for the seed. Each one goes through the service the app's own route calls where one exists, and otherwise
 * inserts the row with every column that route sets
 */
import { randomBytes } from "node:crypto"
import { Readable } from "node:stream"
import bcrypt from "bcryptjs"
import { eq, sql } from "drizzle-orm"
import * as Y from "yjs"
import {
  db,
  docContents,
  fileAttachments,
  fileGrants,
  groupChatMembers,
  groupChats,
  messageReactions,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  taskComments,
  tasks,
  users,
} from "../../src/db"
import { createEvent, loadSeriesState, respondToSeries } from "../../src/services/calendarQueries"
import { chatMessages, insertMessageOnce, savePin } from "../../src/services/chats"
import { createDoc } from "../../src/services/docs"
import { linkFiles } from "../../src/services/files"
import { isProjectMember } from "../../src/services/projectAccess"
import { ensureProjectChat, syncProjectChatMembers } from "../../src/services/projectChat"
import { objectKey, putObjectStream } from "../../src/services/storage"
import { allocateTaskNumber } from "../../src/services/taskNumbers"
import { trashTask } from "../../src/services/taskTrash"
import { createEntry } from "../../src/services/timeEntries"
import { boardElements } from "../../src/utils/boardElements"
import { layoutBoard, type BoardPlan } from "../../src/utils/boardLayout"
import type { DocLevel } from "../../src/utils/docAccess"
import { applyDocWrite, revisionOf } from "../../src/utils/docText"
import { BOARD_FIELD } from "../../src/utils/docYjs"
import { allDayBounds } from "../../src/utils/eventTime"
import type { REACTION_KEYS } from "../../src/utils/reactions"
import type { StatusOverride } from "../../src/utils/statusOverride"
import type { SymbolKey } from "../../src/utils/symbols"
import { normalizeProfile } from "../../src/utils/userProfile"
import { deriveProjectKey } from "../../src/utils/taskKeys"
import { calendarEventCreateBodySchema } from "../../src/validation/schemas"
import { seedNow } from "./time"
import type { SeedAccount } from "./accounts"

export type Person = { id: string; email: string; organizationId: string; isOrgAdmin: boolean }
export type Project = { id: string; slug: string; key: string; organizationId: string; chatId: string }

const now = () => seedNow().toISOString()

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

const hashes = new Map<string, Promise<string>>()
const hashOf = (password: string) => {
  if (!hashes.has(password)) hashes.set(password, bcrypt.hash(password, 10))
  return hashes.get(password)!
}

/** A workspace with its accounts, each with a membership and the workspace as their current one. An `id` fixes the user's id */
export async function createWorkspace(
  name: string,
  accounts: readonly (Omit<SeedAccount, "name" | "workspace"> & { id?: string })[],
  timeTracking: boolean,
): Promise<Map<string, Person>> {
  const [org] = await db.insert(organizations).values({ name, timeTracking }).returning({ id: organizations.id })
  const people = new Map<string, Person>()
  for (const account of accounts) {
    const [user] = await db
      .insert(users)
      .values({
        id: account.id,
        email: account.email,
        firstName: account.firstName,
        lastName: account.lastName,
        passwordHash: await hashOf(account.password),
        role: account.role,
        emailVerified: true,
        organizationId: org.id,
        // Journeys and screenshots start on the page, not behind the welcome cards
        onboarding: { welcomeSeenAt: new Date().toISOString() },
      })
      .returning({ id: users.id })
    await db.insert(organizationMembers).values({ organizationId: org.id, userId: user.id, role: account.role })
    people.set(account.email, { id: user.id, email: account.email, organizationId: org.id, isOrgAdmin: account.role === "admin" })
  }
  return people
}

type ProjectInput = {
  name: string
  description: string
  color: string
  icon?: SymbolKey
  members: { person: Person; role: "admin" | "member" }[]
  startDate?: string
  endDate?: string
}

/** A project as the create route makes it, with its key and its project chat, then its other members seated in that chat */
export async function createProject(owner: Person, input: ProjectInput): Promise<Project> {
  const { organizationId } = owner
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"project-key:" + organizationId}))`)
    const keys = await tx.select({ key: projects.key }).from(projects).where(eq(projects.organizationId, organizationId))
    const key = deriveProjectKey(input.name, new Set(keys.map((row) => row.key).filter((k): k is string => !!k)))
    const [row] = await tx
      .insert(projects)
      .values({
        name: input.name,
        slug: slugify(input.name),
        key,
        description: input.description,
        color: input.color,
        icon: input.icon ?? null,
        organizationId,
        createdBy: owner.id,
        createdVia: null,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
      })
      .returning()
    await tx.insert(projectMembers).values({ projectId: row.id, userId: owner.id, role: "admin", createdAt: now() })
    const chatId = await ensureProjectChat(row.id, tx)
    for (const { person, role } of input.members) {
      if (person.id === owner.id) continue
      if (person.organizationId !== organizationId) throw new Error(`${person.email} is not in the workspace of ${input.name}`)
      await tx.insert(projectMembers).values({ projectId: row.id, userId: person.id, role, createdAt: now() })
    }
    await syncProjectChatMembers(row.id, tx)
    return { id: row.id, slug: row.slug, key, organizationId, chatId }
  })
}

type TaskInput = {
  title: string
  description?: string
  status: "backlog" | "todo" | "in_progress" | "done" | "cancelled"
  priority: "none" | "low" | "medium" | "high" | "urgent"
  assignee: Person
  dueDate?: string
  /** When a done task was finished, now when left out */
  completedAt?: string
  position: number
}

/** A project task numbered from the project's counter, refused when its creator or assignee is not in the project */
export async function addTask(project: Project, creator: Person, input: TaskInput): Promise<string> {
  return db.transaction(async (tx) => {
    const number = await allocateTaskNumber(tx, project.id)
    for (const person of [creator, input.assignee]) {
      if (!(await isProjectMember(project.id, person.id, tx))) {
        throw new Error(`${person.email} is not a member of ${project.slug}, so "${input.title}" can't be theirs`)
      }
    }
    const at = now()
    const [row] = await tx
      .insert(tasks)
      .values({
        title: input.title,
        description: input.description,
        createdBy: creator.id,
        status: input.status,
        priority: input.priority,
        dueDate: input.dueDate ?? null,
        position: input.position,
        organizationId: project.organizationId,
        doneVia: null,
        completedAt: input.status === "done" ? (input.completedAt ?? at) : null,
        createdAt: at,
        updatedAt: at,
        projectId: project.id,
        number,
        assignedTo: input.assignee.id,
      })
      .returning({ id: tasks.id })
    return row.id
  })
}

export async function addTaskComment(taskId: string, author: Person, content: string): Promise<string> {
  const [row] = await db
    .insert(taskComments)
    .values({
      taskId,
      userId: author.id,
      organizationId: author.organizationId,
      content,
      doneVia: null,
      createdAt: now(),
      updatedAt: now(),
    })
    .returning({ id: taskComments.id })
  return row.id
}

export async function trashOne(taskId: string, by: Person): Promise<void> {
  const trashed = await trashTask(taskId, { userId: by.id, organizationId: by.organizationId }, null)
  if (!trashed) throw new Error(`The task ${taskId} could not go to the Trashcan`)
}

export async function createGroupChat(owner: Person, name: string, description: string, members: Person[]): Promise<string> {
  const [chat] = await db
    .insert(groupChats)
    .values({
      name,
      description,
      icon: null,
      color: null,
      organizationId: owner.organizationId,
      createdBy: owner.id,
      createdAt: now(),
      updatedAt: now(),
    })
    .returning({ id: groupChats.id })
  const everyone = [...new Set([owner.id, ...members.map((m) => m.id)])]
  await db
    .insert(groupChatMembers)
    .values(everyone.map((userId) => ({ groupChatId: chat.id, userId, role: userId === owner.id ? "admin" : "member", joinedAt: now() })))
  return chat.id
}

/** A message in a group chat, sent `minutesAgo` minutes ago, optionally as a reply */
export async function sendGroupMessage(
  chatId: string,
  sender: Person,
  content: string,
  minutesAgo: number,
  replyToId: string | null = null,
): Promise<string> {
  const { organizationId } = sender
  const createdAt = new Date(seedNow().getTime() - minutesAgo * 60_000).toISOString()
  const { id } = await insertMessageOnce(chatMessages(organizationId, sender.id, "group", chatId), {
    senderId: sender.id,
    threadType: "group",
    threadId: chatId,
    organizationId,
    content,
    isRead: false,
    isEdited: false,
    createdAt,
    replyToId,
    clientId: null,
    doneVia: null,
  })
  await db.update(groupChats).set({ updatedAt: createdAt }).where(eq(groupChats.id, chatId))
  return id
}

export async function sendDirectMessage(
  sender: Person,
  recipient: Person,
  content: string,
  minutesAgo: number,
  isRead = false,
): Promise<string> {
  const { organizationId } = sender
  const { id } = await insertMessageOnce(chatMessages(organizationId, sender.id, "dm", recipient.id), {
    senderId: sender.id,
    recipientId: recipient.id,
    organizationId,
    content,
    isRead,
    replyToId: null,
    doneVia: null,
    clientId: null,
    createdAt: new Date(seedNow().getTime() - minutesAgo * 60_000).toISOString(),
  })
  return id
}

export type ReactionKey = (typeof REACTION_KEYS)[number]

export async function react(messageId: string, person: Person, emoji: ReactionKey): Promise<void> {
  await db.insert(messageReactions).values({ messageId, userId: person.id, organizationId: person.organizationId, emoji })
}

export async function pin(messageId: string): Promise<void> {
  await savePin({ id: messageId, isPinned: false, pinnedAt: null }, true)
}

/** A paper in the project, written in the paper format the way the AI writes one, with grants for the users named */
export async function createPaper(
  owner: Person,
  project: Project,
  name: string,
  text: string,
  grants: { person: Person; level: DocLevel }[] = [],
): Promise<string> {
  const doc = new Y.Doc()
  const written = applyDocWrite(doc, { op: "append", text, revision: revisionOf(doc) })
  if (!written.ok) throw new Error(`The paper ${name} could not be written: ${written.error}`)
  return storeDoc(owner, project, "paper", name, doc, grants)
}

/** A board in the project, laid out from a plan as the AI's create_board lays one out */
export async function createBoard(owner: Person, project: Project, name: string, plan: BoardPlan): Promise<string> {
  const doc = new Y.Doc()
  const board = doc.getMap<unknown>(BOARD_FIELD)
  const ids = { newId: () => randomBytes(15).toString("base64url") }
  for (const element of boardElements(plan, layoutBoard(plan, []), ids)) board.set(element.id as string, element)
  return storeDoc(owner, project, "board", name, doc)
}

async function storeDoc(
  owner: Person,
  project: Project,
  docType: "paper" | "board",
  name: string,
  doc: Y.Doc,
  grants: { person: Person; level: DocLevel }[] = [],
): Promise<string> {
  const viewer = { userId: owner.id, organizationId: owner.organizationId, isOrgAdmin: owner.isOrgAdmin }
  const id = await createDoc(viewer, docType, { projectId: project.id, folderId: null }, name)
  const state = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  await db.transaction(async (tx) => {
    await tx.update(fileAttachments).set({ fileSize: state.length, updatedAt: now() }).where(eq(fileAttachments.id, id))
    await tx.update(docContents).set({ state, updatedAt: now() }).where(eq(docContents.fileId, id))
    for (const { person, level } of grants) {
      await tx
        .insert(fileGrants)
        .values({ fileId: id, userId: person.id, grantedBy: owner.id, level, organizationId: owner.organizationId })
    }
  })
  return id
}

type EventInput = {
  title: string
  startsAt?: Date
  endsAt?: Date
  /** First and last local day, YYYY-MM-DD, in place of the times */
  allDay?: { from: string; to: string }
  eventType?: "meeting" | "focus" | "personal" | "event" | "task" | "ooo"
  videoCall?: boolean
  description?: string
  location?: string
  guests?: Person[]
  everyone?: boolean
  recurrence?: { rule: string; timeZone: string }
}

/** An event through the calendar's own create, checked by the route's schema first */
export async function addEvent(organiser: Person, input: EventInput): Promise<string> {
  const body = calendarEventCreateBodySchema.parse({
    title: input.title,
    description: input.description ?? null,
    location: input.location ?? null,
    ...(input.allDay
      ? { ...allDayBounds(input.allDay.from, input.allDay.to), all_day: true }
      : { starts_at: input.startsAt?.toISOString(), ends_at: input.endsAt?.toISOString() }),
    video_call: input.videoCall,
    event_type: input.eventType ?? "meeting",
    everyone: input.everyone ?? false,
    recurrence_rule: input.recurrence?.rule ?? null,
    recurrence_tz: input.recurrence?.timeZone ?? null,
    attendee_ids: (input.guests ?? []).map((guest) => guest.id),
  })
  const { id } = await createEvent({ id: organiser.id, organizationId: organiser.organizationId }, body)
  return id
}

/** A guest's reply, saved as the calendar's respond route saves it */
export async function respond(eventId: string, guest: Person, response: "yes" | "no" | "maybe"): Promise<void> {
  const state = await loadSeriesState(guest.organizationId, eventId)
  if (!state || !(await respondToSeries(guest.id, state, response))) throw new Error(`${guest.email} is not a guest of ${eventId}`)
}

export async function logTime(
  person: Person,
  date: string,
  minutes: number,
  place: { taskId: string } | { projectId: string },
  note: string,
) {
  await createEntry(
    { userId: person.id, organizationId: person.organizationId, isOrgAdmin: person.isOrgAdmin },
    { date, minutes, note, source: "manual", ...place },
  )
}

/** A text file stored in the bucket and in the project's files, posted on the task as the upload and the task's attach do */
export async function uploadFile(owner: Person, project: Project, taskId: string, fileName: string, body: string): Promise<string> {
  const bytes = Buffer.from(body)
  const key = objectKey("attachment", owner.organizationId, owner.id, fileName)
  await putObjectStream(key, Readable.from([bytes]), "text/plain")
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(fileAttachments)
      .values({
        fileName,
        filePath: key,
        fileSize: bytes.length,
        mimeType: "text/plain",
        uploadedBy: owner.id,
        organizationId: owner.organizationId,
        kind: "file",
        docFileId: null,
        isDraft: false,
        projectId: project.id,
        folderId: null,
      })
      .returning({ id: fileAttachments.id })
    const linked = await linkFiles({ taskId }, [row.id], { userId: owner.id, organizationId: owner.organizationId }, project.id, tx)
    if (linked.length === 0) throw new Error(`The file ${fileName} could not be posted on its task`)
    return row.id
  })
}

type Profile = Parameters<typeof normalizeProfile>[0]

/** Profile fields checked as the profile route checks them, and a chosen status that lasts until `until` */
export async function setProfile(person: Person, profile: Profile, status?: { value: StatusOverride; until: Date | null }) {
  const fields = normalizeProfile(profile)
  if (!fields.ok) throw new Error(`The profile of ${person.email} was refused: ${fields.error}`)
  await db
    .update(users)
    .set({ ...fields.values, statusOverride: status?.value ?? null, statusUntil: status?.until ?? null, updatedAt: now() })
    .where(eq(users.id, person.id))
}
