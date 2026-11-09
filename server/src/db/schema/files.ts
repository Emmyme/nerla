import { pgTable, uuid, varchar, text, timestamp, boolean, integer, index, jsonb } from "drizzle-orm/pg-core"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { relations, sql } from "drizzle-orm"
import type { Via } from "../../utils/aiTypes"
import { messages } from "./chat"
import { projects, taskComments, tasks } from "./projects"
import { organizations, users } from "./users"

/** One stored object. Where it is posted lives in `file_links` */
export const fileAttachments = pgTable(
  "file_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    filePath: text("file_path").notNull(),
    fileSize: integer("file_size").notNull(),
    mimeType: varchar("mime_type", { length: 100 }),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Set for a project file, which the project owns rather than its uploader */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    folderId: uuid("folder_id").references((): AnyPgColumn => fileFolders.id, { onDelete: "set null" }),
    /** file, avatar or docimage, an image placed in a paper or board */
    kind: varchar("kind", { length: 20 }).default("file").notNull(),
    /** paper or board. A doc's `file_path` is `doc:{id}` and its content lives in `doc_contents` */
    docType: varchar("doc_type", { length: 10 }),
    /** The paper or board a docimage belongs to */
    docFileId: uuid("doc_file_id").references((): AnyPgColumn => fileAttachments.id, { onDelete: "cascade" }),
    isDraft: boolean("is_draft").default(false).notNull(),
    altText: varchar("alt_text", { length: 500 }),
    /** A copy keeps another user's file name until its owner renames it */
    nameCopied: boolean("name_copied").notNull().default(false),
    /** In Trash since */
    deletedAt: timestamp("deleted_at", { mode: "string" }),
    /** The file, folder or project whose deletion trashed it */
    trashRoot: uuid("trash_root"),
    deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "set null" }),
    deletedVia: jsonb("deleted_via").$type<Via>(),
    /** Set when the AI or an agent created the paper or board for its owner */
    doneVia: jsonb("done_via").$type<Via>(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("file_attachments_organization_id_idx").on(table.organizationId),
    index("file_attachments_project_id_idx").on(table.projectId),
    index("file_attachments_folder_id_idx").on(table.folderId),
    index("file_attachments_uploaded_by_idx").on(table.uploadedBy),
    index("file_attachments_deleted_at_idx").on(table.deletedAt),
    index("file_attachments_doc_file_id_idx").on(table.docFileId),
    index("file_attachments_file_name_trgm_idx").using("gin", sql`lower(${table.fileName}) gin_trgm_ops`),
  ],
)

/** Where a file is posted. Deleting the post removes only the link */
export const fileLinks = pgTable(
  "file_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => fileAttachments.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => taskComments.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("file_links_file_id_idx").on(table.fileId),
    index("file_links_message_id_idx").on(table.messageId),
    index("file_links_task_id_idx").on(table.taskId),
    index("file_links_comment_id_idx").on(table.commentId),
    index("file_links_organization_id_idx").on(table.organizationId),
    index("file_links_created_by_idx").on(table.createdBy),
  ],
)

/** A share with a teammate, on exactly one of a file or a folder, enforced in code. Only a paper or board goes above view */
export const fileGrants = pgTable(
  "file_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id").references(() => fileAttachments.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references((): AnyPgColumn => fileFolders.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** view, comment or edit */
    level: varchar("level", { length: 10 }).default("view").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("file_grants_user_id_idx").on(table.userId),
    index("file_grants_file_id_idx").on(table.fileId),
    index("file_grants_folder_id_idx").on(table.folderId),
    index("file_grants_organization_id_idx").on(table.organizationId),
  ],
)

/** An outside link, on exactly one of a file or a folder, enforced in code. A null expiry never expires */
export const fileShareLinks = pgTable(
  "file_share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: varchar("token", { length: 64 }).notNull(),
    fileId: uuid("file_id").references(() => fileAttachments.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references((): AnyPgColumn => fileFolders.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { mode: "string" }),
    revokedAt: timestamp("revoked_at", { mode: "string" }),
    downloadCount: integer("download_count").default(0).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("file_share_links_token_idx").on(table.token),
    index("file_share_links_file_id_idx").on(table.fileId),
    index("file_share_links_folder_id_idx").on(table.folderId),
    index("file_share_links_organization_id_idx").on(table.organizationId),
  ],
)

export const fileAttachmentsRelations = relations(fileAttachments, ({ one, many }) => ({
  uploader: one(users, {
    fields: [fileAttachments.uploadedBy],
    references: [users.id],
  }),
  project: one(projects, {
    fields: [fileAttachments.projectId],
    references: [projects.id],
  }),
  links: many(fileLinks),
}))

export const fileLinksRelations = relations(fileLinks, ({ one }) => ({
  file: one(fileAttachments, {
    fields: [fileLinks.fileId],
    references: [fileAttachments.id],
  }),
  message: one(messages, {
    fields: [fileLinks.messageId],
    references: [messages.id],
  }),
  task: one(tasks, {
    fields: [fileLinks.taskId],
    references: [tasks.id],
  }),
  comment: one(taskComments, {
    fields: [fileLinks.commentId],
    references: [taskComments.id],
  }),
}))

export const fileFolders = pgTable(
  "file_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    color: varchar("color", { length: 20 }),
    icon: varchar("icon", { length: 20 }),
    parentFolderId: uuid("parent_folder_id"),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { mode: "string" }),
    trashRoot: uuid("trash_root"),
    deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "set null" }),
    deletedVia: jsonb("deleted_via").$type<Via>(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("file_folders_parent_folder_id_idx").on(table.parentFolderId),
    index("file_folders_project_id_idx").on(table.projectId),
  ],
)

export const fileFoldersRelations = relations(fileFolders, ({ one, many }) => ({
  parent: one(fileFolders, {
    fields: [fileFolders.parentFolderId],
    references: [fileFolders.id],
    relationName: "parent",
  }),
  children: many(fileFolders, { relationName: "parent" }),
  organization: one(organizations, {
    fields: [fileFolders.organizationId],
    references: [organizations.id],
  }),
  creator: one(users, {
    fields: [fileFolders.createdBy],
    references: [users.id],
  }),
}))
