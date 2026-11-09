import { pgTable, uuid, varchar, timestamp, integer, index, jsonb } from "drizzle-orm/pg-core"
import type { Prefs } from "../../utils/notificationRules"
import type { EventNoticeDetail } from "../../utils/eventNotice"
import { calendarEvents } from "./calendar"
import { messages } from "./chat"
import { fileAttachments } from "./files"
import { projects, taskComments, tasks } from "./projects"
import { organizations, users } from "./users"

/** One entry in a user's bell. It points at its place and never copies its text */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => taskComments.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    /** A paper or board */
    fileId: uuid("file_id").references(() => fileAttachments.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => calendarEvents.id, { onDelete: "cascade" }),
    /** What happened to the event, with its title as the guest saw it then */
    detail: jsonb("detail").$type<EventNoticeDetail>(),
    /** dm or group, with the chat as the recipient knows it: a DM by the other user's id */
    chatKind: varchar("chat_kind", { length: 10 }),
    chatId: uuid("chat_id"),
    /** Task changes by one user to one task within ten minutes share this and merge */
    groupKey: varchar("group_key", { length: 160 }),
    changeCount: integer("change_count").default(1).notNull(),
    readAt: timestamp("read_at", { mode: "string" }),
    /** Moved up when a change merges in, so the entry rises to the top */
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("notifications_user_read_idx").on(table.userId, table.readAt),
    index("notifications_user_created_idx").on(table.userId, table.createdAt),
    index("notifications_task_id_idx").on(table.taskId),
    index("notifications_message_id_idx").on(table.messageId),
    index("notifications_comment_id_idx").on(table.commentId),
    index("notifications_file_id_idx").on(table.fileId),
    index("notifications_event_id_idx").on(table.eventId),
    index("notifications_user_group_idx").on(table.userId, table.groupKey),
    index("notifications_created_at_idx").on(table.createdAt),
  ],
)

/** One row per user and workspace, enforced in code. Missing kinds take their defaults */
export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    prefs: jsonb("prefs").$type<Prefs>().default({}).notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("notification_prefs_user_idx").on(table.userId, table.organizationId)],
)
