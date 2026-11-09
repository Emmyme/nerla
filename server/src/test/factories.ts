import { randomBytes } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import {
  calendarEvents,
  db,
  eventAttendees,
  fileAttachments,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  tasks,
  users,
} from "../db"
import { writeInstant } from "../utils/eventTime"

const tag = () => randomBytes(4).toString("hex")

/** A workspace with one admin, as signup makes it */
export async function makeWorkspace(): Promise<{ orgId: string; adminId: string }> {
  const [org] = await db
    .insert(organizations)
    .values({ name: `Workspace ${tag()}` })
    .returning({ id: organizations.id })
  const adminId = await makeUser(org.id, "admin")
  return { orgId: org.id, adminId }
}

export async function makeUser(orgId: string, role: "admin" | "member" = "member"): Promise<string> {
  const id = tag()
  const [user] = await db
    .insert(users)
    .values({ email: `user-${id}@test.nerla.local`, firstName: "User", lastName: id, emailVerified: true, role, organizationId: orgId })
    .returning({ id: users.id })
  await db.insert(organizationMembers).values({ organizationId: orgId, userId: user.id, role })
  return user.id
}

/** The owner is its admin. Unless private, everyone else in the workspace joins as a member */
export async function makeProject(orgId: string, ownerId: string, opts: { private?: boolean } = {}): Promise<string> {
  const id = tag()
  const [project] = await db
    .insert(projects)
    .values({ name: `Project ${id}`, slug: `project-${id}`, organizationId: orgId, createdBy: ownerId })
    .returning({ id: projects.id })
  const others = opts.private
    ? []
    : (
        await db
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(eq(organizationMembers.organizationId, orgId))
      )
        .map((m) => m.userId)
        .filter((userId) => userId !== ownerId)
  await db
    .insert(projectMembers)
    .values([{ projectId: project.id, userId: ownerId, role: "admin" }, ...others.map((userId) => ({ projectId: project.id, userId }))])
  return project.id
}

export async function makeTask(
  orgId: string,
  opts: { projectId?: string | null; assignedTo?: string; title?: string } = {},
): Promise<string> {
  const [task] = await db
    .insert(tasks)
    .values({
      title: opts.title ?? `Task ${tag()}`,
      projectId: opts.projectId ?? null,
      assignedTo: opts.assignedTo ?? null,
      createdBy: opts.assignedTo ?? null,
      organizationId: orgId,
    })
    .returning({ id: tasks.id })
  return task.id
}

type EventOpts = {
  title?: string
  startsAt: string
  endsAt: string
  eventType?: string
  everyone?: boolean
  videoCall?: boolean
  allDay?: boolean
  guests?: string[]
  recurrenceRule?: string
  seriesId?: string
  originalStart?: string
  cancelled?: boolean
}

/** Times are ISO instants. A series repeats in UTC */
export async function makeEvent(orgId: string, createdBy: string, opts: EventOpts): Promise<string> {
  const [event] = await db
    .insert(calendarEvents)
    .values({
      title: opts.title ?? `Event ${tag()}`,
      startsAt: writeInstant(opts.startsAt),
      endsAt: writeInstant(opts.endsAt),
      allDay: opts.allDay ?? false,
      eventType: opts.eventType ?? "meeting",
      everyone: opts.everyone ?? false,
      videoCall: opts.videoCall ?? false,
      recurrenceRule: opts.recurrenceRule ?? null,
      recurrenceTz: opts.recurrenceRule ? "UTC" : null,
      seriesId: opts.seriesId ?? null,
      originalStart: opts.originalStart ? writeInstant(opts.originalStart) : null,
      cancelled: opts.cancelled ?? false,
      createdBy,
      organizationId: orgId,
    })
    .returning({ id: calendarEvents.id })
  if (opts.guests?.length) {
    await db.insert(eventAttendees).values(opts.guests.map((userId) => ({ eventId: event.id, userId, organizationId: orgId })))
  }
  return event.id
}

/** A stored file of the uploader, or of the project when one is given */
export async function makeFile(orgId: string, uploadedBy: string, opts: { projectId?: string; fileName?: string } = {}): Promise<string> {
  const id = tag()
  const [file] = await db
    .insert(fileAttachments)
    .values({
      fileName: opts.fileName ?? `file-${id}.txt`,
      filePath: `orgs/${orgId}/attachments/${uploadedBy}/${id}.txt`,
      fileSize: 10,
      mimeType: "text/plain",
      uploadedBy,
      organizationId: orgId,
      projectId: opts.projectId ?? null,
    })
    .returning({ id: fileAttachments.id })
  return file.id
}

const TRASHABLE = { projects, tasks, calendarEvents, fileAttachments }

/** Moves an item's Trash time, and what went to Trash with it, back by whole days */
export async function trashedDaysAgo(table: keyof typeof TRASHABLE, id: string, days: number): Promise<void> {
  const target = TRASHABLE[table]
  const when = sql`now() at time zone 'utc' - make_interval(days => ${days})`
  await db.update(target).set({ deletedAt: when }).where(eq(target.id, id))
  if (table !== "projects" && table !== "calendarEvents") return
  for (const child of [tasks, fileAttachments, calendarEvents]) {
    await db.update(child).set({ deletedAt: when }).where(eq(child.trashRoot, id))
  }
}
