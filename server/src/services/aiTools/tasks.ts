import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { db, tasks } from "../../db"
import type { Via } from "../../utils/aiTypes"
import { parseMentions } from "../../utils/mentions"
import { taskAccessLevel } from "../../utils/taskAccess"
import type { toTaskDto } from "../../utils/taskDto"
import { liveTask } from "../../utils/trash"
import { callerMembership } from "../projectAccess"
import { call, clip, LIST_LIMIT, nameOf, personName, projectName, projectShared, textAuthor, tool, uuid, type ToolContext } from "./shared"

type TaskDto = ReturnType<typeof toTaskDto>
type CommentDto = {
  id: string
  user_id: string
  content: string
  created_at: string
  done_via: Via | null
  user: { first_name: string | null; last_name: string | null } | null
}

const STATUSES = ["backlog", "todo", "in_progress", "done", "cancelled"] as const
const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const
const OPEN = new Set(["backlog", "todo", "in_progress"])

const taskRef = (id: string) => ({ kind: "task" as const, id })

const taskItem = (task: TaskDto) => ({
  ref: taskRef(task.id),
  id: task.id,
  identifier: task.identifier,
  title: task.title,
  status: task.status,
  priority: task.priority,
  due_date: task.due_date,
  project_id: task.project_id,
  project: task.project?.name ?? null,
  assignee_id: task.assigned_to,
  assignee: nameOf(task.assignee),
})

/**
 * Who wrote the task's text and the names shown with it: its creator, the assignee for their name, and an unknown author
 * for a project's name or once the task has changed, since a task of the user's own may have been edited in a project
 */
const taskAuthors = (task: TaskDto): (string | null)[] => [
  task.created_by,
  ...(task.assigned_to ? [task.assigned_to] : []),
  ...(task.project_id || task.updated_at !== task.created_at ? [null] : []),
]

const loadTask = (ctx: ToolContext, id: string) => call<TaskDto>(ctx, { method: "GET", url: `/api/tasks/${id}` })

const listTasks = tool({
  name: "list_tasks",
  area: "tasks",
  write: false,
  description: "List tasks: those assigned to the user, or every task in one project. Open tasks unless a status is given.",
  input: z.object({
    projectId: uuid.optional().describe("A project's id. Leave out for the tasks assigned to the user"),
    status: z.enum(STATUSES).optional().describe("Only tasks with this status"),
  }),
  async run(ctx, args) {
    const rows = await call<TaskDto[]>(ctx, {
      method: "GET",
      url: args.projectId ? `/api/tasks/project/${args.projectId}` : "/api/tasks/user",
    })
    const shown = rows.filter((task) => (args.status ? task.status === args.status : OPEN.has(task.status))).slice(0, LIST_LIMIT)
    return { ok: true, data: null, items: shown.map(taskItem), authors: shown.flatMap(taskAuthors) }
  },
})

const readTask = tool({
  name: "read_task",
  area: "tasks",
  write: false,
  description: "Read one task with its description and comments.",
  input: z.object({ taskId: uuid }),
  async run(ctx, args) {
    const [task, comments] = await Promise.all([
      loadTask(ctx, args.taskId),
      call<CommentDto[]>(ctx, { method: "GET", url: `/api/tasks/${args.taskId}/comments` }),
    ])
    const item = {
      ...taskItem(task),
      description: task.description,
      comments: comments.map((comment) => ({ author: nameOf(comment.user), content: comment.content, created_at: comment.created_at })),
    }
    return {
      ok: true,
      data: null,
      items: [item],
      authors: [...taskAuthors(task), ...comments.map((comment) => textAuthor(comment.user_id, comment.done_via))],
      target: taskRef(task.id),
    }
  },
})

const createTask = tool({
  name: "create_task",
  area: "tasks",
  write: true,
  description: "Create a task, in a project or as one of the user's own tasks.",
  input: z.object({
    title: z.string().trim().min(1).max(255),
    description: z.string().max(20000).optional(),
    projectId: uuid.optional().describe("Leave out for one of the user's own tasks"),
    assigneeId: uuid.optional().describe("A project member to assign. The user's own tasks are always theirs"),
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueDate: z.string().max(40).optional().describe("A date, as YYYY-MM-DD"),
  }),
  async run(ctx, args) {
    if (!args.projectId && args.assigneeId && args.assigneeId !== ctx.askerId) {
      return { ok: false, error: "A task of the user's own can't be assigned to someone else. Put it in a project first" }
    }
    const task = await call<TaskDto>(ctx, {
      method: "POST",
      url: "/api/tasks",
      body: {
        title: args.title,
        description: args.description,
        project_id: args.projectId,
        assigned_to: args.assigneeId,
        status: args.status,
        priority: args.priority,
        due_date: args.dueDate,
      },
    })
    return {
      ok: true,
      data: { id: task.id, identifier: task.identifier, title: task.title, project: task.project?.name ?? null },
      authors: task.project ? [null] : [],
      target: taskRef(task.id),
    }
  },
  async othersCanSee(ctx, args) {
    if (args.assigneeId && args.assigneeId !== ctx.askerId) return true
    return args.projectId ? projectShared(ctx, args.projectId) : false
  },
  async summary(args, ctx) {
    const where = args.projectId ? ` in ${await projectName(ctx, args.projectId)}` : ""
    const who = !args.assigneeId
      ? ""
      : args.assigneeId === ctx.askerId
        ? ", assigned to you"
        : `, assigned to ${await personName(ctx, args.assigneeId)}`
    return `Create task ${clip(args.title)}${where}${who}`
  },
})

const updateTask = tool({
  name: "update_task",
  area: "tasks",
  write: true,
  description: "Change a task's title, description, status, priority, assignee, due date or project. Fields left out stay as they are.",
  input: z.object({
    taskId: uuid,
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(20000).optional(),
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assigneeId: uuid.nullable().optional().describe("A project member, or null to unassign"),
    dueDate: z.string().max(40).nullable().optional().describe("A date as YYYY-MM-DD, or null for none"),
    projectId: uuid.nullable().optional().describe("Move to this project, or null to make it the user's own task"),
  }),
  async run(ctx, args) {
    const body: Record<string, unknown> = {}
    if (args.title !== undefined) body.title = args.title
    if (args.description !== undefined) body.description = args.description
    if (args.status !== undefined) body.status = args.status
    if (args.priority !== undefined) body.priority = args.priority
    if (args.assigneeId !== undefined) body.assigned_to = args.assigneeId ?? ""
    if (args.dueDate !== undefined) body.due_date = args.dueDate ?? ""
    if (args.projectId !== undefined) body.project_id = args.projectId
    if (Object.keys(body).length === 0) return { ok: false, error: "Nothing to change" }
    const task = await call<TaskDto>(ctx, { method: "PUT", url: `/api/tasks/${args.taskId}`, body })
    return {
      ok: true,
      data: { id: task.id, identifier: task.identifier, title: task.title, status: task.status },
      authors: taskAuthors(task),
      target: taskRef(task.id),
    }
  },
  async othersCanSee(ctx, args) {
    if (args.assigneeId && args.assigneeId !== ctx.askerId) return true
    if (args.projectId && (await projectShared(ctx, args.projectId))) return true
    try {
      const task = await loadTask(ctx, args.taskId)
      if (task.project_id) return projectShared(ctx, task.project_id)
      return task.assigned_to !== ctx.askerId
    } catch {
      return true
    }
  },
  async summary(args, ctx) {
    const title = clip(
      await loadTask(ctx, args.taskId).then(
        (task) => task.title,
        () => "a task",
      ),
    )
    const assignee = args.assigneeId ? await personName(ctx, args.assigneeId) : null
    const others = [
      args.title !== undefined && `title to ${clip(args.title, 60)}`,
      args.description !== undefined && "the description",
      args.status !== undefined && `status to ${args.status.replace("_", " ")}`,
      args.priority !== undefined && `priority to ${args.priority}`,
      args.dueDate !== undefined && (args.dueDate ? `due date to ${args.dueDate}` : "no due date"),
      args.projectId !== undefined && (args.projectId ? `move to ${await projectName(ctx, args.projectId)}` : "make it a task of your own"),
    ].filter((part): part is string => !!part)
    if (args.assigneeId !== undefined && others.length === 0) {
      return assignee ? `Assign ${assignee} to ${title}` : `Unassign ${title}`
    }
    if (args.assigneeId !== undefined) others.unshift(assignee ? `assign ${assignee}` : "unassign")
    return `Update ${title}: ${others.join(", ")}`
  },
})

const addTaskComment = tool({
  name: "add_task_comment",
  area: "tasks",
  write: true,
  description: "Comment on a task as the user. @[userId] mentions someone and tells them.",
  input: z.object({ taskId: uuid, body: z.string().trim().min(1).max(10000) }),
  async run(ctx, args) {
    const comment = await call<CommentDto>(ctx, { method: "POST", url: `/api/tasks/${args.taskId}/comments`, body: { content: args.body } })
    return { ok: true, data: { id: comment.id, created_at: comment.created_at }, authors: [], target: taskRef(args.taskId) }
  },
  async othersCanSee(ctx, args) {
    if (parseMentions(args.body).some((id) => id !== ctx.askerId)) return true
    try {
      const task = await loadTask(ctx, args.taskId)
      if (task.project_id) return projectShared(ctx, task.project_id)
      return (task.assigned_to ?? ctx.askerId) !== ctx.askerId || task.created_by !== ctx.askerId
    } catch {
      return true
    }
  },
  async summary(args, ctx) {
    const title = clip(
      await loadTask(ctx, args.taskId).then(
        (task) => task.title,
        () => "a task",
      ),
      60,
    )
    return `Comment on ${title}: "${clip(args.body)}"`
  },
})

/** The rule the delete route and `trashTask` apply: a member of its project, or a personal task's assignee */
async function mayChange(ctx: ToolContext, taskId: string): Promise<boolean> {
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId), liveTask),
    columns: { projectId: true, assignedTo: true, organizationId: true, deletedAt: true },
    with: { project: { columns: { organizationId: true, deletedAt: true }, with: callerMembership(ctx.askerId) } },
  })
  return !!task && taskAccessLevel(task, ctx.askerId, ctx.organizationId, false) === "member"
}

const deleteTask = tool({
  name: "delete_task",
  area: "tasks",
  write: true,
  alwaysGated: () => true,
  description: "Move one task to the trash, where it can be restored for 30 days. It always waits for the user's Allow.",
  input: z.object({ taskId: uuid }),
  async precheck(ctx, args) {
    await loadTask(ctx, args.taskId)
    return (await mayChange(ctx, args.taskId)) ? null : "Only a member of the task's project can move it to the trash"
  },
  async run(ctx, args) {
    const task = await loadTask(ctx, args.taskId)
    await call(ctx, { method: "DELETE", url: `/api/tasks/${task.id}` })
    return {
      ok: true,
      data: { id: task.id, identifier: task.identifier, title: task.title, in_trash: true },
      authors: taskAuthors(task),
      target: taskRef(task.id),
    }
  },
  async summary(args, ctx) {
    const task = await loadTask(ctx, args.taskId)
    return `Move task ${task.identifier ? `${task.identifier} ` : ""}${clip(task.title)} to the trash`
  },
})

export const TASK_TOOLS = [listTasks, readTask, createTask, updateTask, addTaskComment, deleteTask]
