import { pgTable, uuid, varchar, text, timestamp, boolean, integer, index, jsonb, date } from "drizzle-orm/pg-core"
import type { Via } from "../../utils/aiTypes"
import { projects, tasks } from "./projects"
import { organizations, users } from "./users"

/** Logged time. `date` is the local day it started on, in the user's zone */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    date: date("date", { mode: "string" }).notNull(),
    minutes: integer("minutes").notNull(),
    note: text("note"),
    /** manual, timer, suggestion or auto */
    source: varchar("source", { length: 20 }).notNull(),
    suggestionKey: varchar("suggestion_key", { length: 200 }),
    startedAt: timestamp("started_at", { mode: "string" }),
    needsCheck: boolean("needs_check").default(false).notNull(),
    checkSeenAt: timestamp("check_seen_at", { mode: "string" }),
    /** An auto entry the user changed, which auto-fill then leaves alone */
    autoEdited: boolean("auto_edited").default(false).notNull(),
    /** Names kept for a locked entry whose project or task was deleted */
    projectName: varchar("project_name", { length: 255 }),
    taskLabel: varchar("task_label", { length: 300 }),
    detachedAt: timestamp("detached_at", { mode: "string" }),
    doneVia: jsonb("done_via").$type<Via>(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("time_entries_org_user_date_idx").on(table.organizationId, table.userId, table.date),
    index("time_entries_project_date_idx").on(table.projectId, table.date),
    index("time_entries_task_id_idx").on(table.taskId),
  ],
)

/** A running timer. One per user, enforced in code */
export const timeTimers = pgTable(
  "time_timers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    note: text("note"),
    startedAt: timestamp("started_at", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("time_timers_org_user_idx").on(table.organizationId, table.userId)],
)

/** A suggestion the user dismissed, by its key */
export const timeDismissals = pgTable(
  "time_dismissals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("time_dismissals_org_user_idx").on(table.organizationId, table.userId)],
)

/** The project a user last picked for meetings with this title, by lower(trim(title)) */
export const timeMeetingProjects = pgTable("time_meeting_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  titleKey: varchar("title_key", { length: 255 }).notNull(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
})

/** A day auto-fill already filled, so an auto entry the user deleted never comes back */
export const timeAutofillDays = pgTable(
  "time_autofill_days",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("time_autofill_days_org_user_idx").on(table.organizationId, table.userId)],
)
