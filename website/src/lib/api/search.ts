import type { EventType } from "@/lib/eventColors"
import type { TaskStatus } from "@/types/tasks"
import { get } from "@/lib/api/request"
import type { FileItem } from "@/lib/api/files"
import type { ChatKind } from "@/lib/api/chat"

type SearchGroup<T> = { items: T[]; more: boolean }

/** Each group holds at most five, and `more` says there are others */
export interface SearchReply {
  files: SearchGroup<FileItem>
  tasks: SearchGroup<{
    id: string
    title: string
    identifier: string | null
    status: TaskStatus
    project: { name: string; slug: string; color: string | null; icon?: string | null } | null
  }>
  projects: SearchGroup<{ id: string; name: string; slug: string; color: string | null; icon?: string | null; member: boolean }>
  people: SearchGroup<{ id: string; name: string; email: string; jobTitle: string | null; team: string | null; avatarUrl: string | null }>
  messages: SearchGroup<{
    id: string
    snippet: string
    createdAt: string
    sender: { id: string; name: string } | null
    chat: { kind: ChatKind; id: string; title: string }
  }>
  /** `ownerId` is whose calendar the event is on */
  events: SearchGroup<{ id: string; title: string; startsAt: string; allDay: boolean; eventType: EventType; ownerId: string }>
}

export const searchAPI = {
  search: (q: string, signal?: AbortSignal): Promise<SearchReply> => get(`/search?q=${encodeURIComponent(q)}`, { signal }),
}
