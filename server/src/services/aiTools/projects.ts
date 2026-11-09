import { z } from "zod"
import type { toProjectDto } from "../../utils/projectDto"
import { projectColorSchema, projectKeySchema } from "../../validation/schemas"
import { call, clip, nameOf, otherAdmins, tool, uuid } from "./shared"

type ProjectDto = ReturnType<typeof toProjectDto> & { member: boolean }
type MemberDto = { user_id: string; role: string; user: { first_name: string | null; last_name: string | null } | null }

const projectRef = (id: string) => ({ kind: "project" as const, id })

/**
 * The creator wrote the name, key and description, unless the AI or an agent made it for them, and once the project is
 * edited, any of its admins may have
 */
const projectAuthors = (project: ProjectDto): (string | null)[] => [
  project.created_via ? null : project.created_by,
  ...(project.updated_at !== project.created_at ? [null] : []),
]

const projectItem = (project: ProjectDto) => ({
  ref: projectRef(project.id),
  id: project.id,
  name: project.name,
  key: project.key,
  status: project.status,
  description: project.description,
  member: project.member,
  task_count: project.task_count,
  done_count: project.done_count,
  next_due: project.next_due,
})

const listProjects = tool({
  name: "list_projects",
  area: "projects",
  write: false,
  description: "List the projects the user can open.",
  input: z.object({}),
  async run(ctx) {
    const rows = await call<ProjectDto[]>(ctx, { method: "GET", url: "/api/projects/all" })
    return { ok: true, data: null, items: rows.map(projectItem), authors: rows.flatMap(projectAuthors) }
  },
})

const readProject = tool({
  name: "read_project",
  area: "projects",
  write: false,
  description: "Read one project with its members.",
  input: z.object({ projectId: uuid }),
  async run(ctx, args) {
    const [project, members] = await Promise.all([
      call<ProjectDto>(ctx, { method: "GET", url: `/api/projects/${args.projectId}` }),
      call<MemberDto[]>(ctx, { method: "GET", url: `/api/projects/${args.projectId}/members` }),
    ])
    const item = {
      ...projectItem(project),
      members: members.map((member) => ({ id: member.user_id, name: nameOf(member.user), role: member.role })),
    }
    return {
      ok: true,
      data: null,
      items: [item],
      authors: [...projectAuthors(project), ...members.map((member) => member.user_id)],
      target: projectRef(project.id),
    }
  },
})

const createProject = tool({
  name: "create_project",
  area: "projects",
  write: true,
  description:
    "Create a project, with the user as its only member and admin, and its project chat. Link it in your answer as [its name](its path). You can't add members, so suggest the user invites people from the project's settings.",
  input: z.object({
    name: z.string().trim().min(1).max(255),
    key: projectKeySchema
      .optional()
      .describe("2 to 5 capital letters or digits starting with a letter, such as WR. Leave out to have one made from the name"),
    description: z.string().max(10000).optional(),
    color: projectColorSchema.optional().describe("A colour as #RRGGBB. Leave out for one picked for the workspace"),
  }),
  async run(ctx, args) {
    const project = await call<ProjectDto>(ctx, { method: "POST", url: "/api/projects", body: args })
    return {
      ok: true,
      data: {
        id: project.id,
        name: project.name,
        key: project.key,
        slug: project.slug,
        path: `/project/${encodeURIComponent(project.slug)}`,
      },
      authors: [],
      target: projectRef(project.id),
    }
  },
  othersCanSee: (ctx) => otherAdmins(ctx),
  placeData: ["name", "key", "path"],
  async summary(args) {
    const description = args.description?.trim() ? `, described as "${clip(args.description.trim().replace(/\s+/g, " "), 160)}"` : ""
    return `Create project ${clip(args.name, 80)}${args.key ? ` (key ${args.key})` : ""}${description}`
  },
})

export const PROJECT_TOOLS = [listProjects, readProject, createProject]
