import { pgTable, uuid, varchar, text, timestamp, boolean, index, jsonb } from "drizzle-orm/pg-core"
import { relations, sql } from "drizzle-orm"
import type { Via } from "../../utils/aiTypes"
import { fileAttachments, fileLinks } from "./files"
import { projects } from "./projects"
import { organizations, users } from "./users"

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    threadType: varchar("thread_type", { length: 50 }),
    threadId: uuid("thread_id"),
    content: text("content").notNull(),
    isRead: boolean("is_read").default(false).notNull(),
    isEdited: boolean("is_edited").default(false).notNull(),
    editedAt: timestamp("edited_at", { mode: "string" }),
    replyToId: uuid("reply_to_id"),
    isPinned: boolean("is_pinned").default(false).notNull(),
    pinnedAt: timestamp("pinned_at", { mode: "string" }),
    /** text or call. A call message has empty content and its room in meta */
    kind: varchar("kind", { length: 20 }).default("text").notNull(),
    meta: jsonb("meta").$type<{ roomName?: string }>(),
    /** The sender's own id for the send, so a retry after a lost reply finds the message it made */
    clientId: varchar("client_id", { length: 64 }),
    doneVia: jsonb("done_via").$type<Via>(),
    /** When a tag in it first asked the AI, so an edit never asks again */
    aiAskedAt: timestamp("ai_asked_at", { mode: "string" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("messages_thread_idx").on(table.threadId, table.createdAt),
    index("messages_client_idx").on(table.senderId, table.clientId),
    index("messages_thread_kind_idx").on(table.threadId, table.kind, table.createdAt),
    index("messages_call_room_idx").on(sql`(${table.meta}->>'roomName')`),
    index("messages_recipient_idx").on(table.recipientId, table.senderId),
    index("messages_sender_idx").on(table.senderId, table.recipientId),
    index("messages_organization_id_idx").on(table.organizationId),
    index("messages_content_trgm_idx").using("gin", sql`lower(${table.content}) gin_trgm_ops`),
  ],
)

export const messageReactions = pgTable(
  "message_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: varchar("emoji", { length: 32 }).notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("message_reactions_organization_id_idx").on(table.organizationId)],
)

export const messageReactionsRelations = relations(messageReactions, ({ one }) => ({
  message: one(messages, {
    fields: [messageReactions.messageId],
    references: [messages.id],
  }),
  user: one(users, {
    fields: [messageReactions.userId],
    references: [users.id],
  }),
}))

export const messagesRelations = relations(messages, ({ one, many }) => ({
  sender: one(users, {
    fields: [messages.senderId],
    references: [users.id],
    relationName: "sender",
  }),
  recipient: one(users, {
    fields: [messages.recipientId],
    references: [users.id],
    relationName: "receiver",
  }),
  replyTo: one(messages, {
    fields: [messages.replyToId],
    references: [messages.id],
    relationName: "replies",
  }),
  replies: many(messages, { relationName: "replies" }),
  fileLinks: many(fileLinks),
  reactions: many(messageReactions),
}))

export const groupChats = pgTable("group_chats", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  /** The picture admins chose in place of a symbol, served from /group-chats/:id/avatar/:fileId */
  avatarFileId: uuid("avatar_file_id").references(() => fileAttachments.id, { onDelete: "set null" }),
  icon: varchar("icon", { length: 20 }),
  color: varchar("color", { length: 20 }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
})

export const groupChatsRelations = relations(groupChats, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [groupChats.organizationId],
    references: [organizations.id],
  }),
  creator: one(users, {
    fields: [groupChats.createdBy],
    references: [users.id],
  }),
  members: many(groupChatMembers),
}))

export const groupChatMembers = pgTable("group_chat_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupChatId: uuid("group_chat_id")
    .notNull()
    .references(() => groupChats.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 50 }).default("member").notNull(),
  joinedAt: timestamp("joined_at", { mode: "string" }).defaultNow().notNull(),
})

/** Where each member has read a group chat up to. One row per chat and user, enforced in code. */
export const groupChatReads = pgTable(
  "group_chat_reads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupChatId: uuid("group_chat_id")
      .notNull()
      .references(() => groupChats.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("group_chat_reads_user_idx").on(table.userId, table.groupChatId)],
)

export const groupChatMembersRelations = relations(groupChatMembers, ({ one }) => ({
  groupChat: one(groupChats, {
    fields: [groupChatMembers.groupChatId],
    references: [groupChats.id],
  }),
  user: one(users, {
    fields: [groupChatMembers.userId],
    references: [users.id],
  }),
}))
