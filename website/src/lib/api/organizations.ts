import { ApiError, get, post, put, del } from "@/lib/api/request"
import type { User } from "@/lib/api/users"
import type { WorkspaceProject } from "@/lib/api/projects"

export interface Organization {
  id: string
  name: string
  role?: "admin" | "member"
  createdAt: string
  updatedAt?: string
  /** Storage limits in bytes, null for no limit */
  storageCapPerPerson?: number | null
  storageCapTotal?: number | null
  maxFileSize?: number | null
  /** The server's own largest upload in bytes, which the admin's limit can only lower */
  uploadCeiling?: number
  timeTracking?: boolean
}

export type StorageCaps = Pick<Organization, "storageCapPerPerson" | "storageCapTotal" | "maxFileSize">

export interface OrganizationMember {
  id: string
  userId: string
  organizationId: string
  role: "admin" | "member"
  user: User
  joinedAt: string
}

/**
 * The invite link is only returned when it is created. The server stores just a
 * hash of the token, so it cannot be shown again later, only replaced.
 */
interface InviteResult {
  inviteUrl: string
  inviteExpiresAt: string
  /** Whether the server is emailing the link too, or has no mail server set up */
  email: "sending" | "not-set-up"
}

/** A new account gets a link. A removed account invited back gets none and rejoins by signing in. */
type InviteResponse = Partial<InviteResult> & {
  message: string
  rejoin?: boolean
  user: Pick<User, "id" | "email" | "firstName" | "lastName"> & { role: string; pendingVerification?: boolean }
}

export interface PendingInvitation {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  role: string
  /** An invite link, or a removed account invited back that rejoins by signing in */
  kind: "invite" | "rejoin"
  invitedAt: string
  expiresAt: string | null
  expired: boolean
  /** The latest invite email, or null when no record of it is left */
  emailStatus: "sending" | "sent" | "failed" | "not-set-up" | null
}

export const organizationsAPI = {
  getCurrentOrganization: async (): Promise<Organization | null> => {
    try {
      return await get("/organizations/current")
    } catch (error) {
      // No organization yet, or the caller is not in it
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
        return null
      }
      throw error
    }
  },

  getOrganizationMembers: async (): Promise<OrganizationMember[]> => {
    try {
      return await get("/organizations/members")
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
        return []
      }
      throw error
    }
  },

  updateOrganization: async (updates: { name?: string; timeTracking?: boolean } & StorageCaps): Promise<{ message: string }> => {
    return put("/organizations", updates)
  },

  inviteUser: async (email: string, firstName?: string, lastName?: string, role = "member"): Promise<InviteResponse> => {
    return post("/organizations/invite", {
      email,
      firstName,
      lastName,
      role,
    })
  },

  getInvitations: async (): Promise<PendingInvitation[]> => {
    return get("/organizations/invitations")
  },

  createInviteLink: async (userId: string): Promise<InviteResult> => {
    return post(`/organizations/invitations/${userId}/link`, {})
  },

  revokeInvitation: async (userId: string): Promise<{ message: string }> => {
    return del(`/organizations/invitations/${userId}`)
  },

  removeMember: async (memberId: string): Promise<void> => {
    await del(`/organizations/members/${memberId}`)
  },

  updateMemberRole: async (memberId: string, role: string): Promise<void> => {
    await put(`/organizations/members/${memberId}/role`, { role })
  },

  /** Admins only. Every project in the workspace, without its contents. */
  getWorkspaceProjects: async (): Promise<WorkspaceProject[]> => {
    return get("/organizations/projects")
  },
}
