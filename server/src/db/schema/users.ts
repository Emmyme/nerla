import { pgTable, uuid, varchar, text, timestamp, boolean, integer, bigint, index, jsonb, date } from "drizzle-orm/pg-core"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { relations, sql } from "drizzle-orm"
import type { DayHours, WorkingHours } from "../../utils/availability"
import type { StatusOverride } from "../../utils/statusOverride"
import type { Accessibility } from "../../utils/accessibility"
import type { Onboarding } from "../../utils/onboarding"
import { calendarEvents } from "./calendar"
import { messages } from "./chat"
import { fileAttachments, fileFolders } from "./files"
import { projects, tasks } from "./projects"

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    firstName: varchar("first_name", { length: 255 }),
    lastName: varchar("last_name", { length: 255 }),
    avatarUrl: text("avatar_url"),
    avatarFileId: uuid("avatar_file_id").references((): AnyPgColumn => fileAttachments.id, {
      onDelete: "set null",
    }),
    passwordHash: text("password_hash"),
    googleId: varchar("google_id", { length: 255 }).unique(),
    githubId: varchar("github_id", { length: 255 }).unique(),
    /** SHA-256 of the emailed reset/invite token, never the token itself. */
    passwordResetToken: varchar("password_reset_token", { length: 255 }),
    passwordResetExpires: timestamp("password_reset_expires", { mode: "string" }),
    /** Which flow issued the token, "invite" or "reset". Each flow accepts only its own. */
    passwordResetKind: varchar("password_reset_kind", { length: 10 }),
    /** Until when a removed account may rejoin `organization_id` by signing in. */
    rejoinInvitedUntil: timestamp("rejoin_invited_until", { mode: "string" }),
    emailVerified: boolean("email_verified").default(false).notNull(),
    role: varchar("role", { length: 50 }).default("member").notNull(),
    /** Bumped to invalidate every JWT issued before the change. */
    tokenVersion: integer("token_version").default(0).notNull(),
    lastLoginAt: timestamp("last_login_at", { mode: "string" }),
    jobTitle: varchar("job_title", { length: 100 }),
    team: varchar("team", { length: 100 }),
    location: varchar("location", { length: 100 }),
    /** An IANA name. Working hours are read in this zone. */
    timeZone: varchar("time_zone", { length: 64 }),
    pronouns: varchar("pronouns", { length: 40 }),
    phone: varchar("phone", { length: 40 }),
    workingHours: jsonb("working_hours").$type<WorkingHours>(),
    /** Breaks on every working day, at most 4. Only auto-fill reads them */
    workBreaks: jsonb("work_breaks").$type<DayHours[]>(),
    /** Shapes with colors, animations off, easier reading and more contrast. Null until the first choice */
    accessibility: jsonb("accessibility").$type<Accessibility>(),
    /** What the user has seen and dismissed of the welcome cards, the getting started checklist and the first-visit tips */
    onboarding: jsonb("onboarding").$type<Onboarding>(),
    /** The project auto-fill logs working hours to, and the day it was turned on */
    timeAutofillProjectId: uuid("time_autofill_project_id").references((): AnyPgColumn => projects.id, { onDelete: "set null" }),
    timeAutofillSince: date("time_autofill_since", { mode: "string" }),
    /** A status the user chose, which wins over the automatic one. Null means automatic. */
    statusOverride: varchar("status_override", { length: 16 }).$type<StatusOverride>(),
    /** When the chosen status ends. Null keeps it until changed. */
    statusUntil: timestamp("status_until", { mode: "date", withTimezone: true }),
    /** When the account left its workspace. Its own files are purged 30 days later */
    removedAt: timestamp("removed_at", { mode: "string" }),
    /**
     * The one workspace this account belongs to. Pending invitees carry it before they have a membership. It stays
     * nullable on purpose, since a removed account keeps its row and belongs to no workspace
     */
    organizationId: uuid("organization_id").references((): AnyPgColumn => organizations.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("users_full_name_trgm_idx").using(
      "gin",
      sql`lower(coalesce(${table.firstName}, '') || ' ' || coalesce(${table.lastName}, '')) gin_trgm_ops`,
    ),
    index("users_email_trgm_idx").using("gin", sql`lower(${table.email}) gin_trgm_ops`),
    index("users_job_title_trgm_idx").using("gin", sql`lower(${table.jobTitle}) gin_trgm_ops`),
    index("users_team_trgm_idx").using("gin", sql`lower(${table.team}) gin_trgm_ops`),
  ],
)

export const usersRelations = relations(users, ({ many }) => ({
  organizationMembers: many(organizationMembers),
  tasks: many(tasks),
  createdCalendarEvents: many(calendarEvents),
  sentMessages: many(messages, { relationName: "sender" }),
  receivedMessages: many(messages, { relationName: "receiver" }),
  createdFolders: many(fileFolders),
}))

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  /** Storage limits in bytes. Null means no cap */
  storageCapPerPerson: bigint("storage_cap_per_person", { mode: "number" }),
  storageCapTotal: bigint("storage_cap_total", { mode: "number" }),
  maxFileSize: bigint("max_file_size", { mode: "number" }),
  timeTracking: boolean("time_tracking").default(false).notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
})

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
  projects: many(projects),
  calendarEvents: many(calendarEvents),
  fileFolders: many(fileFolders),
}))

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 50 }).default("member").notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow(),
  },
  (table) => [index("organization_members_user_id_idx").on(table.userId)],
)

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [organizationMembers.userId],
    references: [users.id],
  }),
}))

export const tokenBlacklist = pgTable("token_blacklist", {
  id: uuid("id").primaryKey().defaultRandom(),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
})
