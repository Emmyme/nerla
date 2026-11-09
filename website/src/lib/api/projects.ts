import type { SymbolKey } from "@/components/ui/symbols"
import { get, post, put, del } from "@/lib/api/request"
import type { UserSummary } from "@/lib/api/users"
import type { TrashRef } from "@/lib/api/trash"

export interface Project {
  id: string
  name: string
  slug: string
  key: string | null
  color: string | null
  /** A symbol key, or null for the plain coloured square */
  icon: string | null
  description: string | null
  status: string
  created_by: string | null
  created_at: string
  updated_at: string
  task_count: number
  done_count: number
  next_due: string | null
  members: UserSummary[]
  chat_id: string | null
  /** False for a workspace admin reading a project they are not in, who sees no chat and changes nothing */
  member?: boolean
  /** Only on the caller's own list, which the sidebar reads */
  pinned?: boolean
  pinned_at?: string | null
}

export type ProjectRole = "admin" | "member"

export interface WorkspaceProject {
  id: string
  name: string
  color: string | null
  icon: string | null
  status: string
  member_count: number
}

interface ProjectMembership {
  id: string
  project_id: string
  user_id: string
  role: ProjectRole
  created_at: string
}

export interface ProjectMember extends ProjectMembership {
  user: (UserSummary & { email: string }) | null
}

export const projectsAPI = {
  getUserProjects: async (): Promise<Project[]> => {
    return get("/projects/user")
  },

  getProjectBySlug: async (slug: string): Promise<Project> => {
    return get(`/projects/slug/${slug}`)
  },

  createProject: async (input: {
    name: string
    key?: string
    color?: string
    icon?: SymbolKey | null
    description?: string
  }): Promise<Project> => {
    return post("/projects", { ...input, key: input.key?.trim().toUpperCase() || undefined })
  },

  updateProject: async (
    projectId: string,
    updates: {
      name?: string
      key?: string
      color?: string
      icon?: SymbolKey | null
      description?: string
      status?: string
    },
  ): Promise<Project> => {
    return put(`/projects/${projectId}`, { ...updates, key: updates.key?.trim().toUpperCase() || undefined })
  },

  /** Moves the project to Trash with everything in it */
  deleteProject: (projectId: string): Promise<TrashRef> => del<{ trash: TrashRef }>(`/projects/${projectId}`).then((reply) => reply.trash),

  /** Already back answers the same, so a second Undo is fine */
  restoreProject: (projectId: string): Promise<Project> => post(`/projects/${projectId}/restore`),

  purgeProject: (projectId: string): Promise<void> => del(`/projects/${projectId}/forever`),

  /** Every project in the workspace for its admins, marked by membership. Others get their own projects */
  getAllProjects: async (): Promise<Project[]> => {
    return get("/projects/all")
  },

  /** Workspace admins only. Joins the project as a member */
  joinProject: async (slug: string): Promise<Project & { joined_as: string }> => {
    return post(`/projects/${encodeURIComponent(slug)}/join`, {})
  },

  pinProject: async (slug: string): Promise<void> => {
    await put(`/projects/${encodeURIComponent(slug)}/pin`, {})
  },

  unpinProject: async (slug: string): Promise<void> => {
    await del(`/projects/${encodeURIComponent(slug)}/pin`)
  },

  getProjectMembers: async (projectId: string): Promise<ProjectMember[]> => {
    return get(`/projects/${projectId}/members`)
  },

  addProjectMember: async (projectId: string, userId: string, role?: ProjectRole): Promise<ProjectMembership> => {
    return post(`/projects/${projectId}/members`, {
      user_id: userId,
      role: role || "member",
    })
  },

  removeProjectMember: async (projectId: string, userId: string): Promise<void> => {
    await del(`/projects/${projectId}/members/${userId}`)
  },

  updateProjectMemberRole: async (projectId: string, userId: string, role: string): Promise<ProjectMembership> => {
    return put(`/projects/${projectId}/members/${userId}`, { role })
  },
}
