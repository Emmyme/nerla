import { get, post, put } from "@/lib/api/request"
import type { ChatKind } from "@/lib/api/chat"
import type { Via } from "@/lib/api/ai"

export const NOTIFICATION_KINDS = [
  "project_added",
  "task_assigned",
  "mentioned",
  "comment_on_my_task",
  "my_task_changed",
  "project_task_added",
  "project_task_changed",
  "project_task_completed",
  "project_comment",
  "doc_shared",
  "doc_comment",
  "ai_pending",
  "event_changed",
] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]
export type NotificationPref = { bell: boolean; desktop: boolean }
export type NotificationPrefs = Record<NotificationKind, NotificationPref>

/** A notification as the server resolves it for the user now. A place the user can no longer reach has no link */
export interface NotificationItem {
  id: string
  kind: NotificationKind
  actor: { id: string; name: string; avatarUrl: string | null } | null
  title: string
  snippet: string | null
  href: string | null
  changeCount: number
  read: boolean
  createdAt: string
  /** Done by the AI or an agent for the actor */
  via?: Via | null
}

export type UnreadPlace = { id: string; taskId: string | null; chat: { kind: ChatKind; id: string } | null }
export type NotificationReadTarget = { ids?: string[]; taskId?: string; chat?: { kind: ChatKind; id: string } }

export const notificationsAPI = {
  summary: (): Promise<{ unread: number; mentionDesktop: boolean; places: UnreadPlace[] }> => get("/notifications/summary"),
  list: (cursor?: string | null): Promise<{ items: NotificationItem[]; unread: number; nextCursor: string | null }> =>
    get(`/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  read: (target: NotificationReadTarget): Promise<{ unread: number }> => post("/notifications/read", target),
  readAll: (): Promise<{ unread: number }> => post("/notifications/read-all"),
  prefs: (): Promise<{ prefs: NotificationPrefs }> => get("/notifications/prefs"),
  savePrefs: (prefs: Partial<Record<NotificationKind, Partial<NotificationPref>>>): Promise<{ prefs: NotificationPrefs }> =>
    put("/notifications/prefs", { prefs }),
}
