import { serverInstant } from "./chatAccess"
import { DAY_MS } from "./eventTime"

export type FileFacts = {
  organizationId: string
  ownerId: string
  ownerRemovedAt: string | null
  projectId: string | null
  /** A docimage belongs to its paper or board, and the doc's level reaches it rather than these rules */
  kind: "file" | "avatar" | "docimage"
  isDraft: boolean
  deletedAt: string | null
  /** Posted only in a chat, with no task or comment link and no folder */
  chatOnly?: boolean
}

export type ViewerFacts = {
  userId: string
  organizationId: string
  isOrgAdmin: boolean
  /** The viewer's role in the file's project, where the creator counts as admin. `viewer` is a workspace admin outside it */
  projectRole: "admin" | "member" | "viewer" | null
  /** A link to a message, task or comment the viewer can reach */
  seesALink: boolean
  /** A grant on the file or an ancestor folder */
  hasGrant: boolean
}

type FileRole = "owner" | "project" | "shared" | null

export type FileAction =
  "view" | "rename" | "move" | "trash" | "restore" | "purge" | "share" | "link" | "copy" | "attach" | "editAlt" | "adminDelete"

/** A stored `kind` as the rules read it */
export const factsKind = (kind: string): FileFacts["kind"] => (kind === "avatar" || kind === "docimage" ? kind : "file")

export const REMOVAL_DAYS = 30

export function removalDeadline(removedAt: string, days = REMOVAL_DAYS): string {
  return new Date(serverInstant(removedAt) + days * DAY_MS).toISOString()
}

/** Another workspace, an avatar, a doc's image, or another user's draft, which no action reaches */
function hidden(file: FileFacts, viewer: ViewerFacts): boolean {
  return file.organizationId !== viewer.organizationId || file.kind !== "file" || (file.isDraft && file.ownerId !== viewer.userId)
}

export function fileRole(file: FileFacts, viewer: ViewerFacts): FileRole {
  if (hidden(file, viewer)) return null
  const isUploader = file.ownerId === viewer.userId
  if (file.projectId) {
    // Project chats stay private from a workspace admin outside the project, and so do the files posted only there
    if (viewer.projectRole === "viewer" && file.chatOnly) return null
    const member = viewer.projectRole === "viewer" ? null : viewer.projectRole
    if (file.deletedAt) return member === "admin" || (isUploader && member) ? "project" : null
    if (viewer.projectRole) return "project"
    return viewer.seesALink || viewer.hasGrant ? "shared" : null
  }
  if (isUploader) return file.ownerRemovedAt ? null : "owner"
  if (file.deletedAt || !(viewer.seesALink || viewer.hasGrant)) return null
  if (file.ownerRemovedAt && Date.now() >= serverInstant(removalDeadline(file.ownerRemovedAt))) return null
  return "shared"
}

export function can(action: FileAction, file: FileFacts, viewer: ViewerFacts): boolean {
  if (hidden(file, viewer)) return false
  // Admin delete is permanent, so a file not yet placed in a workspace is never in reach
  if (action === "adminDelete") return viewer.isOrgAdmin && file.organizationId === viewer.organizationId
  const role = fileRole(file, viewer)
  if (!role) return false
  if (file.deletedAt) return action === "view" || action === "restore" || action === "purge"

  const isProject = file.projectId !== null
  // A workspace admin outside the project reads its files and may save a copy, nothing more
  if (isProject && viewer.projectRole === "viewer") return action === "view" || action === "copy"
  const isUploader = file.ownerId === viewer.userId
  const isOwner = role === "owner"
  const projectMember = isProject && viewer.projectRole !== null
  const projectAdmin = isProject && viewer.projectRole === "admin"
  switch (action) {
    case "view":
      return true
    case "rename":
    case "move":
    case "attach":
      return isOwner || projectMember
    case "trash":
      return isOwner || (isProject && (isUploader || projectAdmin))
    case "share":
      return isOwner && !isProject
    case "link":
      return isOwner || projectAdmin
    case "copy":
      return !isOwner
    case "editAlt":
      return isUploader
    // A composer's chip removed before sending goes at once, without a stop in Trash
    case "purge":
      return file.isDraft && isOwner
    default:
      return false
  }
}

/** A project file goes back only into its own project. Every other file goes wherever the viewer may attach it */
export function canLinkInto(target: { projectId: string | null }, file: FileFacts, viewer: ViewerFacts): boolean {
  if (!can("attach", file, viewer)) return false
  return file.projectId === null || file.projectId === target.projectId
}
