import { fileRole, type FileFacts, type ViewerFacts } from "./fileAccess"

export const DOC_TYPES = ["paper", "board"] as const
export const DOC_LEVELS = ["view", "comment", "edit"] as const

export type DocType = (typeof DOC_TYPES)[number]
export type DocLevel = (typeof DOC_LEVELS)[number]

export const DOC_MIME: Record<DocType, string> = {
  paper: "application/vnd.nerla.paper",
  board: "application/vnd.nerla.board",
}

/** Where a doc's row points instead of a stored object, which storage never touches */
export const docPath = (fileId: string) => `doc:${fileId}`
export const isDocPath = (path: string) => path.startsWith("doc:")

const RANK: Record<DocLevel, number> = { view: 1, comment: 2, edit: 3 }

export function maxLevel(a: DocLevel | null, b: DocLevel | null): DocLevel | null {
  if (!a) return b
  if (!b) return a
  return RANK[a] >= RANK[b] ? a : b
}

/** Whether `level` gives less than `than` */
export const levelBelow = (level: DocLevel, than: DocLevel): boolean => RANK[level] < RANK[than]

/** A level the user passes on, never above their own */
export const capLevel = (requested: DocLevel, own: DocLevel): DocLevel => (RANK[requested] <= RANK[own] ? requested : own)

/** Viewers never see comments */
export const canSeeComments = (level: DocLevel | null): boolean => level === "comment" || level === "edit"

type DocViewerFacts = ViewerFacts & { grantLevel: DocLevel | null; callLevel: DocLevel | null }

/** The level from the Files rules alone, before any call share */
function roleLevel(file: FileFacts, viewer: DocViewerFacts): DocLevel | null {
  const role = fileRole(file, viewer)
  if (!role) return null
  let level: DocLevel | null = null
  if (role === "owner") level = "edit"
  else if (role === "project") level = viewer.projectRole === "viewer" ? "view" : "edit"
  const granted = viewer.hasGrant ? (viewer.grantLevel ?? "view") : null
  return maxLevel(level, maxLevel(granted, viewer.seesALink ? "view" : null))
}

/**
 * The highest level that applies: the owner and project members edit, a workspace admin outside the project views,
 * a grant gives its level, a chat or task post gives view, and an open call share gives its level to those in the
 * call even where the Files rules hide the doc
 */
export function docLevel(file: FileFacts & { docType: DocType }, viewer: DocViewerFacts): DocLevel | null {
  if (file.organizationId !== viewer.organizationId) return null
  const level = maxLevel(roleLevel(file, viewer), viewer.callLevel)
  // Trash only reads, as it does for other files
  return level && file.deletedAt ? "view" : level
}

/** What an attendee keeps once a call share closes */
export function keptAfterCall(
  share: { forMeeting: boolean; level: DocLevel; openedByOwner: boolean; projectId: string | null },
  attendee: { isProjectMember: boolean },
): DocLevel | null {
  if (share.projectId && !attendee.isProjectMember) return null
  if (share.forMeeting) return share.level
  return share.openedByOwner ? capLevel("view", share.level) : null
}
