import { z } from "zod"
import type { EntryDto } from "../timeEntries"
import { call, clip, projectName, tool, uuid, type ToolContext } from "./shared"

const duration = (minutes: number) => {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return [hours && `${hours}h`, rest && `${rest}m`].filter(Boolean).join(" ")
}

async function taskTitle(ctx: ToolContext, taskId: string): Promise<string> {
  try {
    return clip((await call<{ title: string }>(ctx, { method: "GET", url: `/api/tasks/${taskId}` })).title, 60)
  } catch {
    // The call itself answers "not found"
    return "a task"
  }
}

/** The task, the project, or both when both are given, so the card names everything the entry is logged on */
async function placeName(ctx: ToolContext, args: { projectId?: string; taskId?: string }): Promise<string> {
  const project = args.projectId ? clip(await projectName(ctx, args.projectId), 60) : null
  if (!args.taskId) return project ?? "a project"
  const task = await taskTitle(ctx, args.taskId)
  return project ? `${task} in ${project}` : task
}

const logTime = tool({
  name: "log_time",
  area: "time",
  write: true,
  description: "Log time the user spent, on a project or a task.",
  input: z
    .object({
      date: z.iso.date().describe("YYYY-MM-DD"),
      minutes: z.number().int().min(1).max(1440),
      projectId: uuid.optional(),
      taskId: uuid.optional(),
      note: z.string().trim().max(500).optional(),
    })
    .refine((args) => !!(args.projectId || args.taskId), { message: "Pick a project or a task" }),
  async run(ctx, args) {
    const { entry } = await call<{ entry: EntryDto }>(ctx, {
      method: "POST",
      url: "/api/time/entries",
      body: { date: args.date, minutes: args.minutes, projectId: args.projectId, taskId: args.taskId, note: args.note, source: "manual" },
    })
    return {
      ok: true,
      data: { id: entry.id, date: entry.date, minutes: entry.minutes },
      authors: [],
      target: args.taskId ? { kind: "task", id: args.taskId } : { kind: "project", id: args.projectId! },
    }
  },
  async othersCanSee(ctx, args) {
    if (args.projectId) return true
    try {
      return !!(await call<{ project_id: string | null }>(ctx, { method: "GET", url: `/api/tasks/${args.taskId}` })).project_id
    } catch {
      return true
    }
  },
  async summary(args, ctx) {
    return `Log ${duration(args.minutes)} on ${await placeName(ctx, args)}, ${args.date}`
  },
})

export const TIME_TOOLS = [logTime]
