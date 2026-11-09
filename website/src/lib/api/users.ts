import type { Availability, DayHours, WorkingHours } from "@/lib/availability"
import type { StatusChoice, StatusOverride } from "@/lib/presence"
import type { SavedAccessibility } from "@/lib/accessibility"
import { get, post, put } from "@/lib/api/request"

export interface User {
  id: string
  email: string
  firstName: string
  lastName: string
  avatarUrl?: string
  role: string
  emailVerified: boolean
  lastLogin: string
  createdAt: string
  jobTitle?: string | null
  team?: string | null
  location?: string | null
  timeZone?: string | null
  pronouns?: string | null
  phone?: string | null
  workingHours?: WorkingHours | null
  /** The same breaks on every working day, only for filling hours */
  workBreaks?: DayHours[] | null
  accessibility?: SavedAccessibility
}

export interface UserSearchResult {
  id: string
  email: string
  firstName: string
  lastName: string
  avatarUrl?: string
}

/** The optional profile fields everyone in the workspace can see */
export type ProfileFieldKey = "jobTitle" | "team" | "location" | "timeZone" | "pronouns" | "phone"

/** A user's card, only ever for a user in the viewer's organization */
export interface UserProfile {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  avatar_url: string | null
  role: "admin" | "member"
  job_title: string | null
  team: string | null
  location: string | null
  time_zone: string | null
  pronouns: string | null
  phone: string | null
  /** Computed by the server under the calendar sharing rules */
  availability: Availability
}

export interface UserSummary {
  id: string
  first_name: string | null
  last_name: string | null
  avatar_url: string | null
}

export const authAPI = {
  getCurrentUser: async (): Promise<User> => {
    return get("/auth/me")
  },

  logout: async () => {
    await post("/auth/logout")
  },

  forgotPassword: async (email: string): Promise<void> => {
    await post("/auth/forgot-password", { email })
  },
}

export const avatarAPI = {
  getAvatar: async (avatarUrl: string): Promise<Blob> => {
    // A user's photo, the AI's avatar an admin uploaded, or a group's picture
    const fileIdMatch = avatarUrl.match(/\/(users|ai|group-chats\/[0-9a-f-]+)\/avatar\/([^/?]+)/)
    if (!fileIdMatch) {
      throw new Error("Invalid avatar URL format")
    }
    const [, owner, fileId] = fileIdMatch
    return get(`/${owner}/avatar/${fileId}`, { responseType: "blob" })
  },
}

export const usersAPI = {
  searchUsers: async (query: string): Promise<UserSearchResult[]> => {
    return get(`/users/search?q=${encodeURIComponent(query)}`)
  },

  getUser: async (userId: string): Promise<UserProfile> => {
    return get(`/users/${encodeURIComponent(userId)}`)
  },

  updateProfile: async (
    updates: {
      firstName?: string
      lastName?: string
      avatarFileId?: string | null
    } & Partial<Record<ProfileFieldKey, string | null>> & {
        workingHours?: WorkingHours | null
        workBreaks?: DayHours[] | null
        accessibility?: SavedAccessibility
      },
  ): Promise<User> => {
    return put("/users/profile", updates)
  },
}

export type OnboardingTip = "home" | "chat" | "calendar" | "files" | "time" | "project" | "ai"
export type OnboardingStepId = "profile" | "task" | "event" | "message" | "doc" | "ai" | "desktop" | "invite" | "setup" | "aiOn"
/** Steps the user may skip */
export type OptionalStep = "desktop" | "aiOn"

/** The user's getting started state. The server ticks each step from what the user has done, on any device */
export interface Onboarding {
  welcomeSeen: boolean
  checklistDismissed: boolean
  tips: OnboardingTip[]
  steps: { id: OnboardingStepId; state: "done" | "skipped" | "todo"; optional: boolean }[]
}

export const onboardingAPI = {
  get: (): Promise<Onboarding> => get("/users/onboarding"),
  save: (change: { welcomeSeen?: true; checklistDismissed?: true; skip?: OptionalStep; tip?: OnboardingTip }): Promise<{ ok: boolean }> =>
    put("/users/onboarding", change),
}

/** A user's live state and calendar availability. `changesAt` is when the availability may next change. */
export type PresenceEntry = {
  online: boolean
  idle: boolean
  inCall: boolean
  availability: Availability
  changesAt?: string
  status?: StatusChoice | null
}

export const presenceAPI = {
  /** Up to 200 ids. Users outside the workspace are left out. */
  query: async (ids: string[]): Promise<{ people: Record<string, PresenceEntry> }> => {
    return post("/presence/query", { ids })
  },
  /** The user's own status, or "auto" for the automatic one. `until` is an ISO instant. */
  setStatus: async (status: StatusOverride | "auto", until: string | null): Promise<{ status: StatusChoice | null }> => {
    return put("/presence/status", { status, until })
  },
}
