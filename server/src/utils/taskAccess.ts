type AccessTask = {
  projectId: string | null
  assignedTo: string | null
  organizationId: string
  deletedAt: string | null
  project?: { organizationId: string; deletedAt: string | null; members?: { userId: string }[] } | null
}

const inTrash = (task: AccessTask) => !!task.deletedAt || !!task.project?.deletedAt

/**
 * Who may change a task: project tasks their project's members, personal tasks their assignee, inside their workspace
 * only. Nobody reaches a task in Trash, or one whose project is
 */
export function canAccessTask(task: AccessTask, userId: string, organizationId: string): boolean {
  if (task.organizationId !== organizationId || inTrash(task)) return false
  if (task.projectId) {
    return task.project?.organizationId === organizationId && !!task.project.members?.some((m) => m.userId === userId)
  }
  return task.assignedTo === userId
}

export type TaskAccessLevel = "member" | "admin-viewer" | null

/** `member` may read and change the task. A workspace admin outside its project may only read it, and personal tasks stay their assignee's */
export function taskAccessLevel(task: AccessTask, userId: string, organizationId: string, isOrgAdmin: boolean): TaskAccessLevel {
  if (canAccessTask(task, userId, organizationId)) return "member"
  if (inTrash(task)) return null
  if (isOrgAdmin && task.projectId && task.organizationId === organizationId && task.project?.organizationId === organizationId) {
    return "admin-viewer"
  }
  return null
}

/** Membership means a `project_members` row on that project. */
export type TaskMove = {
  fromPersonal: boolean
  toPersonal: boolean
  callerInSource: boolean
  callerInTarget: boolean
  isAssignee: boolean
  hasOthersContent: boolean
}

type MoveRefusal = { code: 400 | 403; error: string }

export function moveRefusal(move: TaskMove): MoveRefusal | null {
  if ((!move.fromPersonal && !move.callerInSource) || (!move.toPersonal && !move.callerInTarget)) {
    return {
      code: 403,
      error: "You need to be a member of both projects to move this task",
    }
  }
  if (move.toPersonal && !move.isAssignee) {
    return { code: 400, error: "Only your own tasks can become personal" }
  }
  if (move.toPersonal && move.hasOthersContent) {
    return {
      code: 400,
      error: "This task has comments or files from other people, so it can't become personal",
    }
  }
  return null
}
