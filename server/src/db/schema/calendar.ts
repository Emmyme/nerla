import { pgTable, uuid, varchar, text, timestamp, boolean, integer, index, jsonb } from "drizzle-orm/pg-core"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { relations, sql } from "drizzle-orm"
import type { Via } from "../../utils/aiTypes"
import { organizations, users } from "./users"

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    location: text("location"),
    startsAt: timestamp("starts_at", { mode: "string" }).notNull(),
    endsAt: timestamp("ends_at", { mode: "string" }).notNull(),
    allDay: boolean("all_day").default(false).notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 50 }).default("meeting").notNull(),
    videoCall: boolean("video_call").default(false).notNull(),
    everyone: boolean("everyone").default(false).notNull(),
    /** An RRULE body without DTSTART, expanded in `recurrence_tz`. */
    recurrenceRule: text("recurrence_rule"),
    recurrenceTz: varchar("recurrence_tz", { length: 64 }),
    /** Set on override rows, pointing at the series master. */
    seriesId: uuid("series_id").references((): AnyPgColumn => calendarEvents.id, {
      onDelete: "cascade",
    }),
    originalStart: timestamp("original_start", { mode: "string" }),
    cancelled: boolean("cancelled").default(false).notNull(),
    reminderMinutes: integer("reminder_minutes"),
    doneVia: jsonb("done_via").$type<Via>(),
    /** In Trash since */
    deletedAt: timestamp("deleted_at", { mode: "string" }),
    deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "set null" }),
    deletedVia: jsonb("deleted_via").$type<Via>(),
    /** The id of the Trash entry the row went with */
    trashRoot: uuid("trash_root"),
    /** The guests of a trashed occurrence, so a restore puts them back */
    trashGuests: jsonb("trash_guests").$type<{ userId: string; response: string }[]>(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("calendar_events_series_id_idx").on(table.seriesId),
    index("calendar_events_title_trgm_idx").using("gin", sql`lower(${table.title}) gin_trgm_ops`),
    index("calendar_events_deleted_at_idx")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} is not null`),
  ],
)

export const calendarEventsRelations = relations(calendarEvents, ({ one, many }) => ({
  creator: one(users, {
    fields: [calendarEvents.createdBy],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [calendarEvents.organizationId],
    references: [organizations.id],
  }),
  attendees: many(eventAttendees),
}))

export const eventAttendees = pgTable(
  "event_attendees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** pending, yes, no or maybe. One row per event and user, enforced in code. */
    response: varchar("response", { length: 10 }).default("pending").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("event_attendees_event_id_idx").on(table.eventId),
    index("event_attendees_user_id_idx").on(table.userId),
    index("event_attendees_organization_id_idx").on(table.organizationId),
  ],
)

export const eventAttendeesRelations = relations(eventAttendees, ({ one }) => ({
  event: one(calendarEvents, {
    fields: [eventAttendees.eventId],
    references: [calendarEvents.id],
  }),
  user: one(users, {
    fields: [eventAttendees.userId],
    references: [users.id],
  }),
}))

/** A user without a row shares at the default level, details. */
export const calendarSharing = pgTable("calendar_sharing", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  defaultLevel: varchar("default_level", { length: 10 }).default("details").notNull(),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
})

/** busy or everything. One row per owner and grantee, enforced in code. */
export const calendarShareGrants = pgTable(
  "calendar_share_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    granteeId: uuid("grantee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    level: varchar("level", { length: 12 }).notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("calendar_share_grants_owner_id_idx").on(table.ownerId),
    index("calendar_share_grants_organization_id_idx").on(table.organizationId),
  ],
)
