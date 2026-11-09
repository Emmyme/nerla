import { pgTable, uuid, varchar, text, timestamp, integer, index, uniqueIndex, jsonb, date } from "drizzle-orm/pg-core"
import { relations, sql } from "drizzle-orm"
import type { Via } from "../../utils/aiTypes"
import { fileLinks } from "./files"
import { organizations, users } from "./users"

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    key: varchar("key", { length: 10 }),
    taskCounter: integer("task_counter").default(0).notNull(),
    description: text("description"),
    status: varchar("status", { length: 50 }).default("active").notNull(),
    color: varchar("color", { length: 7 }).default("#3b82f6"),
    icon: varchar("icon", { length: 20 }),
    createdBy: uuid("created_by").references(() => users.id),
    /** Set when the AI or an agent made the project, so its words never count as the creator's own */
    createdVia: jsonb("created_via").$type<Via>(),
    startDate: timestamp("start_date", { mode: "string" }),
    endDate: timestamp("end_date", { mode: "string" }),
    /** Time on or before this date is locked */
    timeLockedUntil: date("time_locked_until", { mode: "string" }),
    /** In Trash since */
    deletedAt: timestamp("deleted_at", { mode: "string" }),
    deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "set null" }),
    deletedVia: jsonb("deleted_via").$type<Via>(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("projects_org_slug_unique").on(table.organizationId, table.slug),
    uniqueIndex("projects_org_key_unique")
      .on(table.organizationId, table.key)
      .where(sql`${table.key} is not null`),
    index("projects_name_trgm_idx").using("gin", sql`lower(${table.name}) gin_trgm_ops`),
    index("projects_deleted_at_idx")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} is not null`),
  ],
)

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  tasks: many(tasks),
  members: many(projectMembers),
}))

export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 50 }).default("member").notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("project_members_project_user_idx").on(table.projectId, table.userId)],
)

/** A project a user keeps at the top of the sidebar. One per user and project, enforced in code */
export const projectPins = pgTable(
  "project_pins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("project_pins_user_id_idx").on(table.userId), index("project_pins_project_id_idx").on(table.projectId)],
)

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, {
    fields: [projectMembers.projectId],
    references: [projects.id],
  }),
  user: one(users, {
    fields: [projectMembers.userId],
    references: [users.id],
  }),
}))

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    number: integer("number"),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 50 }).default("todo").notNull(),
    priority: varchar("priority", { length: 50 }).default("medium").notNull(),
    assignedTo: uuid("assigned_to").references(() => users.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => users.id),
    position: integer("position").default(0),
    dueDate: timestamp("due_date", { mode: "string" }),
    completedAt: timestamp("completed_at", { mode: "string" }),
    doneVia: jsonb("done_via").$type<Via>(),
    /** In Trash since */
    deletedAt: timestamp("deleted_at", { mode: "string" }),
    deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "set null" }),
    deletedVia: jsonb("deleted_via").$type<Via>(),
    /** The project's id when the task went to Trash with its project, null when it went on its own */
    trashRoot: uuid("trash_root"),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("tasks_organization_id_idx").on(table.organizationId),
    uniqueIndex("tasks_project_number_unique")
      .on(table.projectId, table.number)
      .where(sql`${table.number} is not null`),
    index("tasks_title_trgm_idx").using("gin", sql`lower(${table.title}) gin_trgm_ops`),
    index("tasks_deleted_at_idx")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} is not null`),
    index("tasks_trash_root_idx")
      .on(table.trashRoot)
      .where(sql`${table.trashRoot} is not null`),
  ],
)

export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    doneVia: jsonb("done_via").$type<Via>(),
    /** When a tag in it first asked the AI, so an edit never asks again */
    aiAskedAt: timestamp("ai_asked_at", { mode: "string" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("task_comments_organization_id_idx").on(table.organizationId)],
)

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
  }),
  assignee: one(users, {
    fields: [tasks.assignedTo],
    references: [users.id],
  }),
  comments: many(taskComments),
  fileLinks: many(fileLinks),
  activity: many(taskActivity),
}))

export const taskCommentsRelations = relations(taskComments, ({ one, many }) => ({
  task: one(tasks, {
    fields: [taskComments.taskId],
    references: [tasks.id],
  }),
  user: one(users, {
    fields: [taskComments.userId],
    references: [users.id],
  }),
  fileLinks: many(fileLinks),
}))

export const taskActivity = pgTable(
  "task_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    field: varchar("field", { length: 20 }).notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    doneVia: jsonb("done_via").$type<Via>(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("task_activity_organization_id_idx").on(table.organizationId)],
)

export const taskActivityRelations = relations(taskActivity, ({ one }) => ({
  task: one(tasks, {
    fields: [taskActivity.taskId],
    references: [tasks.id],
  }),
  user: one(users, {
    fields: [taskActivity.userId],
    references: [users.id],
  }),
}))
