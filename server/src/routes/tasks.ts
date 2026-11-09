import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { authMiddleware } from "../middleware/auth"
import { orgMiddleware, orgOf } from "../services/tenancy"
import { db, tasks, projects, taskComments, taskActivity, fileLinks, users, type Tx } from "../db"
import { eq, and, desc, asc, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm"
import { parseBody, parseParams, parseQuery } from "../validation/helpers"
import {
  taskCreateBodySchema,
  taskUpdateBodySchema,
  idParamsSchema,
  projectIdParamsSchema,
  taskIdParamsSchema,
  commentIdParamsSchema,
  taskCommentPostBodySchema,
  taskCommentPutBodySchema,
  messageAttachmentParamsSchema,
  taskSummariesQuerySchema,
} from "../validation/schemas"
import { logger } from "../utils/logger"
import { AI_WORDS, saidByAi } from "../utils/aiTypes"
import { toTaskDto } from "../utils/taskDto"
import { formatTaskIdentifier } from "../utils/taskKeys"
import { presenceName } from "../utils/presence"
import { ACTIVITY_FIELDS, activityLabel, diffTaskActivity, diffTaskText } from "../utils/taskActivity"
import { moveRefusal, taskAccessLevel, type TaskAccessLevel } from "../utils/taskAccess"
import { liveProject, liveTask } from "../utils/trash"
import {
  callerMembership,
  isProjectMember,
  ADMIN_VIEWER,
  memberProjectIds,
  projectReadAccess,
  readableProjectIds,
} from "../services/projectAccess"
import { LINKED_FILES, linkAttachments, linkFiles } from "../services/files"
import { announceRemoved, dropNotifications, notify } from "../services/notifications"
import { purgeTask, restoreTask, taskTrashAccess, trashTask } from "../services/taskTrash"
import { allocateTaskNumber, PROJECT_GONE } from "../services/taskNumbers"
import { projectOfTask, tasksChanged } from "../services/taskLive"
import { addedAiMention, addedMentions, mentionsAi, parseMentions } from "../utils/mentions"
import { mentionAi } from "../services/aiMention"
import type { NotificationEvent } from "../utils/notificationRules"
import { viaOf } from "../utils/via"
import { UUID } from "../utils/uuid"
import { READ_ONLY, toISOStringOrNull } from "./helpers"

const projectColumns = {
  id: true,
  name: true,
  slug: true,
  key: true,
  color: true,
  icon: true,
} as const

const userColumns = {
  id: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
} as const

const taskRefs = {
  project: { columns: projectColumns },
  assignee: { columns: userColumns },
} as const

type Caller = { organizationId: string; role: string }

/** The task with how far the caller may go: `member` changes it, `admin-viewer` only reads it */
async function loadReadableTask(taskId: string, user: { id: string }, member: Caller) {
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.organizationId, member.organizationId), liveTask),
    with: {
      project: { with: callerMembership(user.id) },
      assignee: { columns: userColumns },
    },
  })
  const level = task ? taskAccessLevel(task, user.id, member.organizationId, member.role === "admin") : null
  return task && level ? { task, level } : null
}

/** The task for a change, or the refusal already sent: 404 when it is out of sight, 403 when it is only readable */
async function loadWritableTask(taskId: string, user: { id: string }, member: Caller, reply: FastifyReply, gone: { error: string }) {
  const found = await loadReadableTask(taskId, user, member)
  if (!found) {
    reply.code(404).send(gone)
    return null
  }
  if (found.level !== "member") {
    reply.code(403).send(READ_ONLY)
    return null
  }
  return found.task
}

/** A workspace admin outside the project sees its project files and their own, never another user's personal files */
const shownLinks = <L extends { file: { projectId: string | null; uploadedBy: string } }>(
  links: L[],
  level: TaskAccessLevel,
  userId: string,
) => (level === "member" ? links : links.filter((link) => link.file.projectId !== null || link.file.uploadedBy === userId))

async function loadTaskDto(taskId: string) {
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), liveTask),
    with: taskRefs,
  })
  return task ? toTaskDto(task, task.project, task.assignee) : null
}

type Refusal = { code: 400 | 403 | 404; error: string }

const ASSIGNEE_REFUSED = new Error("Assigned user is not a project member")
const CALLER_NOT_MEMBER = new Error("Caller left the project")

const findProject = (tx: Tx, projectId: string, userId: string) =>
  tx.query.projects.findFirst({
    where: and(eq(projects.id, projectId), liveProject),
    with: callerMembership(userId),
  })

async function hasOthersContent(tx: Tx, taskId: string, userId: string) {
  const [comment] = await tx
    .select({ id: taskComments.id })
    .from(taskComments)
    .where(and(eq(taskComments.taskId, taskId), ne(taskComments.userId, userId)))
    .limit(1)
  if (comment) return true

  const commentIds = tx.select({ id: taskComments.id }).from(taskComments).where(eq(taskComments.taskId, taskId))
  // tenancy: the caller loaded the task inside its workspace, and links follow their task
  const [link] = await tx
    .select({ id: fileLinks.id })
    .from(fileLinks)
    .where(and(ne(fileLinks.createdBy, userId), or(eq(fileLinks.taskId, taskId), inArray(fileLinks.commentId, commentIds))))
    .limit(1)
  return !!link
}

const COMMENT_WITH = {
  user: {
    columns: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
    },
  },
  fileLinks: LINKED_FILES,
} as const

type CommentRow = NonNullable<Awaited<ReturnType<typeof findComment>>>

function findComment(commentId: string, organizationId: string) {
  return db.query.taskComments.findFirst({
    where: and(eq(taskComments.id, commentId), eq(taskComments.organizationId, organizationId)),
    with: COMMENT_WITH,
  })
}

function commentDto(comment: CommentRow) {
  return {
    id: comment.id,
    task_id: comment.taskId,
    user_id: comment.userId,
    content: comment.content,
    done_via: comment.doneVia ?? null,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    user: comment.user
      ? {
          id: comment.user.id,
          email: comment.user.email,
          first_name: comment.user.firstName,
          last_name: comment.user.lastName,
          avatar_url: comment.user.avatarUrl,
        }
      : null,
    attachments: linkAttachments(comment.fileLinks),
  }
}

const activityFieldOrder = sql`case ${taskActivity.field} ${sql.raw(
  ACTIVITY_FIELDS.map((field, i) => `when '${field}' then ${i}`).join(" "),
)} end`

const fullName = (user: { firstName: string | null; lastName: string | null }) => [user.firstName, user.lastName].filter(Boolean).join(" ")

async function taskRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.get("/user", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user

    try {
      const member = orgOf(request)

      const myTasks = await db.query.tasks.findMany({
        where: and(
          eq(tasks.assignedTo, user.id),
          liveTask,
          or(
            and(isNull(tasks.projectId), eq(tasks.organizationId, member.organizationId)),
            inArray(tasks.projectId, memberProjectIds(user.id, member.organizationId)),
          ),
        ),
        with: taskRefs,
        orderBy: [desc(tasks.createdAt)],
      })

      return reply.send(myTasks.map((task) => toTaskDto(task, task.project, task.assignee)))
    } catch (error) {
      logger.error("Error fetching user tasks:", error)
      return reply.code(500).send({ error: "Failed to fetch tasks" })
    }
  })

  fastify.get("/project/:projectId", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(projectIdParamsSchema, request.params, reply)
    if (!params) return
    const { projectId } = params

    try {
      const member = orgOf(request)

      const access = await projectReadAccess(user.id, member.organizationId, projectId)

      if (!access) {
        return reply.code(404).send({ error: "Project not found" })
      }

      const projectTasks = await db.query.tasks.findMany({
        where: and(eq(tasks.projectId, projectId), eq(tasks.organizationId, member.organizationId), liveTask),
        with: { assignee: { columns: userColumns } },
        orderBy: [asc(tasks.position), desc(tasks.createdAt)],
      })

      return reply.send(projectTasks.map((task) => toTaskDto(task, access.project, task.assignee)))
    } catch (error) {
      logger.error("Error fetching project tasks:", error)
      return reply.code(500).send({ error: "Failed to fetch tasks" })
    }
  })

  fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const body = parseBody(taskCreateBodySchema, request.body, reply)
    if (!body) return

    try {
      const member = orgOf(request)

      // The app clock writes updated_at here and on PUT, so clients can order copies by it
      const now = new Date().toISOString()
      const values = {
        title: body.title,
        description: body.description,
        createdBy: user.id,
        status: body.status || "todo",
        priority: body.priority || "medium",
        dueDate: toISOStringOrNull(body.due_date),
        position: body.position || 0,
        organizationId: member.organizationId,
        doneVia: viaOf(request),
        createdAt: now,
        updatedAt: now,
      }

      const projectId = body.project_id
      if (!projectId) {
        const [task] = await db
          .insert(tasks)
          .values({ ...values, projectId: null, assignedTo: user.id })
          .returning()

        return reply.code(201).send(await loadTaskDto(task.id))
      }

      const access = await projectReadAccess(user.id, member.organizationId, projectId)
      if (!access) return reply.code(404).send({ error: "Project not found" })
      if (access.role === ADMIN_VIEWER) return reply.code(403).send(READ_ONLY)

      // The number allocation locks the project row against a concurrent leave. A refusal throws, so the number rolls back too
      const task = await db.transaction(async (tx) => {
        const number = await allocateTaskNumber(tx, projectId)
        const assignee = body.assigned_to ?? user.id
        if (!(await isProjectMember(projectId, assignee, tx))) {
          throw body.assigned_to ? ASSIGNEE_REFUSED : CALLER_NOT_MEMBER
        }
        const [created] = await tx
          .insert(tasks)
          .values({
            ...values,
            projectId,
            number,
            assignedTo: body.assigned_to === undefined ? user.id : body.assigned_to,
          })
          .returning()
        return created
      })
      void notify(member.organizationId, { type: "task_added", actorId: user.id, taskId: task.id })
      await tasksChanged(member.organizationId, [projectId])

      return reply.code(201).send(await loadTaskDto(task.id))
    } catch (error) {
      if (error === ASSIGNEE_REFUSED) {
        return reply.code(400).send({ error: "Assigned user is not a project member" })
      }
      if (error === CALLER_NOT_MEMBER || error === PROJECT_GONE) {
        return reply.code(404).send({ error: "Project not found" })
      }
      logger.error("Error creating task:", error)
      return reply.code(500).send({ error: "Failed to create task" })
    }
  })

  /** A paper's task lines in one request. A task the caller can't open shows only that it is hidden */
  fastify.get("/summaries", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const query = parseQuery(taskSummariesQuerySchema, request.query, reply)
    if (!query) return
    const ids = [...new Set(query.ids)]
    if (ids.length === 0) return reply.send([])
    const member = orgOf(request)
    const valid = ids.filter((id) => UUID.test(id)).map((id) => id.toLowerCase())
    const rows = valid.length
      ? await db.query.tasks.findMany({
          where: and(inArray(tasks.id, valid), eq(tasks.organizationId, member.organizationId), liveTask),
          with: { project: { with: callerMembership(user.id) }, assignee: { columns: userColumns } },
        })
      : []
    const byId = new Map(rows.map((task) => [task.id, task]))
    return reply.send(
      ids.map((id) => {
        const task = byId.get(id.toLowerCase())
        if (!task || !taskAccessLevel(task, user.id, member.organizationId, member.role === "admin")) return { id, hidden: true }
        return {
          id,
          identifier: formatTaskIdentifier(task.project?.key ?? null, task.number),
          title: task.title,
          status: task.status,
          assignee: task.assignee
            ? {
                id: task.assignee.id,
                name: presenceName(task.assignee.firstName, task.assignee.lastName),
                avatarUrl: task.assignee.avatarUrl,
              }
            : null,
        }
      }),
    )
  })

  fastify.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params

    try {
      const member = orgOf(request)

      const found = await loadReadableTask(id, user, member)

      if (!found) {
        return reply.code(404).send({ error: "Task not found" })
      }
      const { task, level } = found

      const links = await db.query.fileLinks.findMany({
        where: and(eq(fileLinks.taskId, id), eq(fileLinks.organizationId, member.organizationId)),
        ...LINKED_FILES,
      })

      return reply.send(toTaskDto(task, task.project, task.assignee, linkAttachments(shownLinks(links, level, user.id))))
    } catch (error) {
      logger.error("Error fetching task:", error)
      return reply.code(500).send({ error: "Failed to fetch task" })
    }
  })

  fastify.put("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params
    const body = parseBody(taskUpdateBodySchema, request.body, reply)
    if (!body) return

    try {
      const member = orgOf(request)
      let unlinkedFiles = 0
      let change: NotificationEvent | null = null
      let projectIds: (string | null)[] = []

      const refusal = await db.transaction(async (tx): Promise<Refusal | null> => {
        const [task] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, id), eq(tasks.organizationId, member.organizationId), liveTask))
          .for("update")
        const source = task?.projectId ? await findProject(tx, task.projectId, user.id) : null

        const level = task ? taskAccessLevel({ ...task, project: source }, user.id, member.organizationId, member.role === "admin") : null
        if (!task || !level) return { code: 404, error: "Task not found" }
        if (level !== "member") return { code: 403, error: READ_ONLY.error }

        const targetProjectId = body.project_id === undefined ? task.projectId : (body.project_id?.toLowerCase() ?? null)
        const moving = targetProjectId !== task.projectId

        if (moving) {
          const target = targetProjectId ? await findProject(tx, targetProjectId, user.id) : null

          const inTarget = !!target?.members.some((m) => m.userId === user.id)
          if (targetProjectId && (target?.organizationId !== member.organizationId || !inTarget)) {
            return { code: 404, error: "Project not found" }
          }

          const refused = moveRefusal({
            fromPersonal: !source,
            toPersonal: !target,
            callerInSource: !!source?.members.some((m) => m.userId === user.id),
            callerInTarget: inTarget,
            isAssignee: task.assignedTo === user.id,
            hasOthersContent: !target && (await hasOthersContent(tx, id, user.id)),
          })
          if (refused) return refused
        }

        let assignedTo = task.assignedTo
        let reassigning = false
        if (body.assigned_to !== undefined) {
          assignedTo = body.assigned_to.toLowerCase() || null
          reassigning = assignedTo !== task.assignedTo
        }

        if (!targetProjectId) {
          if (assignedTo !== user.id) {
            return {
              code: 400,
              error: "A personal task cannot be reassigned",
            }
          }
        } else if (assignedTo && (moving || reassigning)) {
          // Holds off a concurrent leave until commit. A move takes the lock its task number needs anyway
          await tx
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.id, targetProjectId), liveProject))
            .for(moving ? "no key update" : "share")
          if (!(await isProjectMember(targetProjectId, assignedTo, tx))) {
            if (reassigning) {
              return {
                code: 400,
                error: "Assigned user is not a project member",
              }
            }
            assignedTo = null
          }
        }

        const updateData: Partial<typeof tasks.$inferInsert> = {}
        if (assignedTo !== task.assignedTo) {
          updateData.assignedTo = assignedTo
        }
        if (body.title !== undefined) updateData.title = body.title
        if (body.description !== undefined) updateData.description = body.description
        if (body.status !== undefined) updateData.status = body.status
        if (body.priority !== undefined) updateData.priority = body.priority
        if (body.due_date !== undefined) {
          updateData.dueDate = toISOStringOrNull(body.due_date)
        }
        if (body.position !== undefined) updateData.position = body.position

        if (body.completed_at !== undefined) {
          updateData.completedAt = toISOStringOrNull(body.completed_at)
        } else {
          // Auto-set completedAt when status moves to/from 'done'
          if (body.status === "done" && !task.completedAt) {
            updateData.completedAt = new Date().toISOString()
          } else if (body.status && body.status !== "done" && task.completedAt) {
            updateData.completedAt = null
          }
        }

        if (moving) {
          updateData.projectId = targetProjectId
          updateData.number = targetProjectId ? await allocateTaskNumber(tx, targetProjectId) : null
        }
        updateData.organizationId = member.organizationId
        updateData.updatedAt = new Date().toISOString()

        const [updatedTask] = await tx.update(tasks).set(updateData).where(eq(tasks.id, id)).returning()
        projectIds = [task.projectId, updatedTask.projectId]

        if (moving && task.projectId) {
          // The old project's files stay in its Files, so the task and its comments let go of them
          const unlinked = await tx.execute<{ file_id: string }>(sql`
              delete from file_links l using file_attachments f
              where f.id = l.file_id and f.project_id = ${task.projectId}::uuid
                and f.organization_id = ${member.organizationId}::uuid
                and l.organization_id = ${member.organizationId}::uuid
                and (l.task_id = ${id}::uuid
                  or l.comment_id in (select c.id from task_comments c where c.task_id = ${id}::uuid))
              returning l.file_id`)
          unlinkedFiles = new Set(unlinked.map((row) => row.file_id)).size
        }

        const changes = diffTaskActivity(task, updatedTask)
        const fields = new Set(changes.map((c) => c.field))
        const statusOrDue = fields.has("status") || fields.has("due_date")
        const notified = [
          fields.has("status"),
          fields.has("due_date"),
          fields.has("assignee"),
          updatedTask.title !== task.title,
          updatedTask.description !== task.description,
        ].filter(Boolean).length
        if (notified > 0) {
          change = {
            type: "task_changed",
            actorId: user.id,
            taskId: id,
            assigned: fields.has("assignee") && !!updatedTask.assignedTo,
            statusOrDue,
            completed: updatedTask.status === "done" && task.status !== "done",
            changes: notified,
          }
        }
        // An edit through an agent or the AI also keeps the old title and description, so it can be undone by hand
        const via = viaOf(request)
        const rows = via ? [...changes, ...diffTaskText(task, updatedTask)] : changes
        if (rows.length > 0) {
          await tx.insert(taskActivity).values(
            rows.map((change) => ({
              taskId: id,
              userId: user.id,
              organizationId: member.organizationId,
              field: change.field,
              fromValue: change.from,
              toValue: change.to,
              doneVia: via,
            })),
          )
        }
        return null
      })

      if (refusal) {
        return reply.code(refusal.code).send({ error: refusal.error })
      }
      if (change) void notify(member.organizationId, change)
      await tasksChanged(member.organizationId, projectIds)

      return reply.send({ ...(await loadTaskDto(id)), unlinkedFiles })
    } catch (error) {
      if (error === PROJECT_GONE) return reply.code(404).send({ error: "Project not found" })
      logger.error(`Failed to update task ${id}:`, error)
      return reply.code(500).send({ error: "Failed to update task" })
    }
  })

  fastify.delete("/:id/attachments/:fileId", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(messageAttachmentParamsSchema, request.params, reply)
    if (!params) return

    try {
      const member = orgOf(request)
      // Anyone who can edit the task
      const task = await loadWritableTask(params.id, user, member, reply, { error: "Task not found" })
      if (!task) return reply

      const removed = await db
        .delete(fileLinks)
        .where(
          and(eq(fileLinks.taskId, params.id), eq(fileLinks.fileId, params.fileId), eq(fileLinks.organizationId, member.organizationId)),
        )
        .returning({ id: fileLinks.id })
      if (removed.length === 0) {
        return reply.code(404).send({ error: "File not found" })
      }
      await tasksChanged(member.organizationId, [task.projectId])
      return reply.send({ message: "Attachment removed" })
    } catch (error) {
      logger.error("Error removing task attachment:", error)
      return reply.code(500).send({ error: "Failed to remove attachment" })
    }
  })

  fastify.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params

    try {
      const member = orgOf(request)

      const task = await loadWritableTask(id, user, member, reply, { error: "Task not found" })
      if (!task) return reply

      const trashed = await trashTask(id, { userId: user.id, organizationId: member.organizationId }, viaOf(request))
      if (!trashed) return reply.code(404).send({ error: "Task not found" })
      await tasksChanged(member.organizationId, [task.projectId])
      return reply.send({ trash: { kind: "task", id: trashed.id } })
    } catch (error) {
      logger.error("Error deleting task:", error)
      return reply.code(500).send({ error: "Failed to delete task" })
    }
  })

  fastify.post("/:id/restore", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return

    try {
      const member = orgOf(request)
      const restored = await restoreTask(params.id, { userId: user.id, organizationId: member.organizationId }, viaOf(request))
      if (!restored) return reply.code(404).send({ error: "Task not found" })
      if ("refused" in restored) return reply.code(409).send({ error: restored.refused })
      await tasksChanged(member.organizationId, [await projectOfTask(member.organizationId, restored.id)])
      const dto = await loadTaskDto(restored.id)
      if (!dto) return reply.code(404).send({ error: "Task not found" })
      return reply.send(dto)
    } catch (error) {
      logger.error("Error restoring task:", error)
      return reply.code(500).send({ error: "Failed to restore the task. Try again in a moment" })
    }
  })

  fastify.delete("/:id/forever", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return

    try {
      const member = orgOf(request)
      const access = await taskTrashAccess(params.id, { userId: user.id, organizationId: member.organizationId })
      if (!access) return reply.code(404).send({ error: "Task not found" })
      if (!access.rights.purge) {
        return reply.code(403).send({ error: "Only a project admin or the person who moved this task to the trash can delete it for good" })
      }
      const projectId = await projectOfTask(member.organizationId, params.id)
      if (!(await purgeTask(params.id, member.organizationId, { allowed: access.allowed }))) {
        return reply.code(404).send({ error: "Task not found" })
      }
      await tasksChanged(member.organizationId, [projectId])
      return reply.send({ message: "Task deleted for good" })
    } catch (error) {
      logger.error("Error deleting task for good:", error)
      return reply.code(500).send({ error: "Failed to delete the task. Try again in a moment" })
    }
  })

  fastify.get("/:id/activity", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(idParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params

    try {
      const member = orgOf(request)

      if (!(await loadReadableTask(id, user, member))) {
        return reply.code(404).send({ error: "Task not found" })
      }

      const rows = await db.query.taskActivity.findMany({
        where: and(eq(taskActivity.taskId, id), eq(taskActivity.organizationId, member.organizationId)),
        with: { user: { columns: userColumns } },
        orderBy: [asc(taskActivity.createdAt), asc(activityFieldOrder)],
      })

      const valuesOf = (field: string) => [
        ...new Set(
          rows
            .filter((row) => row.field === field)
            .flatMap((row) => [row.fromValue, row.toValue])
            .filter((value): value is string => !!value),
        ),
      ]
      const userIds = valuesOf("assignee")
      const projectIds = valuesOf("project")

      const [named, namedProjects] = await Promise.all([
        userIds.length > 0
          ? db
              .select({
                id: users.id,
                firstName: users.firstName,
                lastName: users.lastName,
              })
              .from(users)
              .where(inArray(users.id, userIds))
          : [],
        projectIds.length > 0
          ? db
              .select({ id: projects.id, name: projects.name })
              .from(projects)
              .where(
                and(
                  inArray(projects.id, projectIds),
                  liveProject,
                  inArray(projects.id, readableProjectIds(user.id, member.organizationId)),
                ),
              )
          : [],
      ])

      const names = {
        users: new Map(named.map((u) => [u.id, fullName(u)])),
        projects: new Map(namedProjects.map((p) => [p.id, p.name])),
      }

      // Ids of projects the viewer is not in are withheld along with their names
      const shown = (field: string, value: string | null) => (field === "project" && value && !names.projects.has(value) ? null : value)

      return reply.send(
        rows.map((row) => ({
          id: row.id,
          field: row.field,
          from_value: shown(row.field, row.fromValue),
          to_value: shown(row.field, row.toValue),
          from_label: activityLabel(row.field, row.fromValue, names),
          to_label: activityLabel(row.field, row.toValue, names),
          done_via: row.doneVia ?? null,
          created_at: row.createdAt,
          user: row.user
            ? {
                id: row.user.id,
                first_name: row.user.firstName,
                last_name: row.user.lastName,
                avatar_url: row.user.avatarUrl,
              }
            : null,
        })),
      )
    } catch (error) {
      logger.error("Error fetching task activity:", error)
      return reply.code(500).send({ error: "Failed to fetch activity" })
    }
  })

  fastify.get("/:taskId/comments", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(taskIdParamsSchema, request.params, reply)
    if (!params) return
    const { taskId } = params

    try {
      const member = orgOf(request)

      const found = await loadReadableTask(taskId, user, member)

      if (!found) {
        return reply.code(404).send({ error: "Task not found" })
      }

      const comments = await db.query.taskComments.findMany({
        where: and(eq(taskComments.taskId, taskId), eq(taskComments.organizationId, member.organizationId)),
        with: COMMENT_WITH,
        orderBy: [asc(taskComments.createdAt)],
      })

      return reply.send(
        comments.map((comment) => commentDto({ ...comment, fileLinks: shownLinks(comment.fileLinks, found.level, user.id) })),
      )
    } catch (error) {
      logger.error("Error fetching comments:", error)
      return reply.code(500).send({ error: "Failed to fetch comments" })
    }
  })

  fastify.post("/:taskId/comments", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(taskIdParamsSchema, request.params, reply)
    if (!params) return
    const { taskId } = params
    const body = parseBody(taskCommentPostBodySchema, request.body, reply)
    if (!body) return

    try {
      const member = orgOf(request)

      const task = await loadWritableTask(taskId, user, member, reply, { error: "Task not found" })
      if (!task) return reply

      const now = new Date().toISOString()
      const comment = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(taskComments)
          .values({
            taskId,
            userId: user.id,
            organizationId: member.organizationId,
            content: body.content.trim(),
            doneVia: viaOf(request),
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        if (body.fileIds?.length) {
          await linkFiles(
            { commentId: row.id },
            body.fileIds,
            { userId: user.id, organizationId: member.organizationId },
            task.projectId,
            tx,
          )
        }
        return row
      })

      void notify(member.organizationId, {
        type: "comment",
        actorId: user.id,
        taskId,
        commentId: comment.id,
        mentions: parseMentions(comment.content),
        edited: false,
      })

      if (!viaOf(request) && mentionsAi(comment.content)) {
        mentionAi({
          asker: { userId: user.id, organizationId: member.organizationId, isAdmin: member.role === "admin" },
          place: { kind: "task_comment", taskId },
          text: comment.content,
          source: { kind: "task_comment", id: comment.id },
        })
      }

      const completeComment = await findComment(comment.id, member.organizationId)
      return reply.code(201).send(commentDto(completeComment!))
    } catch (error) {
      logger.error("Error creating comment:", error)
      return reply.code(500).send({ error: "Failed to create comment" })
    }
  })

  fastify.put("/comments/:commentId", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(commentIdParamsSchema, request.params, reply)
    if (!params) return
    const { commentId } = params
    const body = parseBody(taskCommentPutBodySchema, request.body, reply)
    if (!body) return

    try {
      const member = orgOf(request)

      const comment = await db.query.taskComments.findFirst({
        where: and(eq(taskComments.id, commentId), eq(taskComments.organizationId, member.organizationId)),
      })

      const gone = { error: "Comment not found" }
      if (!comment) return reply.code(404).send(gone)
      const task = await loadWritableTask(comment.taskId, user, member, reply, gone)
      if (!task) return reply

      if (comment.userId !== user.id) {
        return reply.code(403).send({ error: "Not authorized to edit this comment" })
      }
      if (saidByAi(comment.doneVia)) return reply.code(403).send({ error: AI_WORDS })

      await db.transaction(async (tx) => {
        await tx
          .update(taskComments)
          .set({
            content: body.content.trim(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(taskComments.id, commentId))
        if (!body.fileIds) return
        const keep = body.fileIds
        await tx
          .delete(fileLinks)
          .where(
            and(
              eq(fileLinks.commentId, commentId),
              eq(fileLinks.organizationId, member.organizationId),
              keep.length ? notInArray(fileLinks.fileId, keep) : undefined,
            ),
          )
        if (keep.length) {
          await linkFiles({ commentId }, keep, { userId: user.id, organizationId: member.organizationId }, task.projectId, tx)
        }
      })

      const mentions = addedMentions(comment.content, body.content.trim())
      if (mentions.length > 0) {
        void notify(member.organizationId, { type: "comment", actorId: user.id, taskId: comment.taskId, commentId, mentions, edited: true })
      }
      // A tag added by the edit asks the AI, by the same rules as a new comment, unless the comment asked before
      if (!viaOf(request) && addedAiMention(comment.content, body.content.trim())) {
        mentionAi({
          asker: { userId: user.id, organizationId: member.organizationId, isAdmin: member.role === "admin" },
          place: { kind: "task_comment", taskId: comment.taskId },
          text: body.content.trim(),
          source: { kind: "task_comment", id: commentId },
        })
      }

      const completeComment = await findComment(commentId, member.organizationId)
      return reply.send(commentDto(completeComment!))
    } catch (error) {
      logger.error("Error updating comment:", error)
      return reply.code(500).send({ error: "Failed to update comment" })
    }
  })

  fastify.delete("/comments/:commentId", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(commentIdParamsSchema, request.params, reply)
    if (!params) return
    const { commentId } = params

    try {
      const member = orgOf(request)

      const comment = await db.query.taskComments.findFirst({
        where: and(eq(taskComments.id, commentId), eq(taskComments.organizationId, member.organizationId)),
      })

      const gone = { error: "Comment not found" }
      if (!comment) return reply.code(404).send(gone)
      if (!(await loadWritableTask(comment.taskId, user, member, reply, gone))) return reply

      if (comment.userId !== user.id) {
        return reply.code(403).send({ error: "Not authorized to delete this comment" })
      }

      const removed = await db.transaction(async (tx) => {
        const dropped = await dropNotifications(tx, member.organizationId, { commentId })
        await tx.delete(taskComments).where(eq(taskComments.id, commentId))
        return dropped
      })
      void announceRemoved(member.organizationId, removed)

      return reply.send({ message: "Comment deleted successfully" })
    } catch (error) {
      logger.error("Error deleting comment:", error)
      return reply.code(500).send({ error: "Failed to delete comment" })
    }
  })
}

export default taskRoutes
