import type { projects, tasks, users } from "../db/schema"
import type { AttachmentDto } from "../services/files"
import { formatTaskIdentifier } from "./taskKeys"

type TaskRow = typeof tasks.$inferSelect
type TaskProject = Pick<typeof projects.$inferSelect, "id" | "name" | "slug" | "key" | "color" | "icon">
type TaskAssignee = Pick<typeof users.$inferSelect, "id" | "firstName" | "lastName" | "avatarUrl">

export function toTaskDto(
  task: TaskRow,
  project: TaskProject | null | undefined,
  assignee: TaskAssignee | null | undefined,
  attachments: AttachmentDto[] = [],
) {
  return {
    id: task.id,
    identifier: formatTaskIdentifier(project?.key ?? null, task.number),
    number: task.number,
    project_id: task.projectId,
    project: project
      ? {
          id: project.id,
          name: project.name,
          slug: project.slug,
          key: project.key,
          color: project.color,
          icon: project.icon,
        }
      : null,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assigned_to: task.assignedTo,
    assignee: assignee
      ? {
          id: assignee.id,
          first_name: assignee.firstName,
          last_name: assignee.lastName,
          avatar_url: assignee.avatarUrl,
        }
      : null,
    created_by: task.createdBy,
    done_via: task.doneVia ?? null,
    position: task.position,
    due_date: task.dueDate,
    completed_at: task.completedAt,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    attachments,
  }
}
