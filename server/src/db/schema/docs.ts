import { pgTable, uuid, varchar, text, timestamp, boolean, index, jsonb, date } from "drizzle-orm/pg-core"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import type { Via } from "../../utils/aiTypes"
import { calendarEvents } from "./calendar"
import { bytea, orgColumn } from "./columns"
import { fileAttachments } from "./files"
import { users } from "./users"

const docColumn = () =>
  uuid("file_id")
    .notNull()
    .references(() => fileAttachments.id, { onDelete: "cascade" })

/** A paper or board's live state as one Yjs update, with a small picture for previews */
export const docContents = pgTable(
  "doc_contents",
  {
    fileId: uuid("file_id")
      .primaryKey()
      .references(() => fileAttachments.id, { onDelete: "cascade" }),
    organizationId: orgColumn(),
    state: bytea("state").notNull(),
    thumbnail: bytea("thumbnail"),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("doc_contents_organization_id_idx").on(table.organizationId)],
)

/** A snapshot of a doc, with who changed it since the one before. The newest 200 are kept, in code */
export const docVersions = pgTable(
  "doc_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    fileId: docColumn(),
    state: bytea("state").notNull(),
    editorIds: jsonb("editor_ids").$type<string[]>().default([]).notNull(),
    via: jsonb("via").$type<Via>(),
    /** A copy's first version, whose text came from a doc whose authors the copy never names */
    copied: boolean("copied").default(false).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("doc_versions_file_created_idx").on(table.fileId, table.createdAt)],
)

/** A comment on a selection or a spot, or a reply when `parent_id` is set. A guest's has `guest_name` and no author */
export const docComments = pgTable(
  "doc_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    fileId: docColumn(),
    parentId: uuid("parent_id").references((): AnyPgColumn => docComments.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    guestName: varchar("guest_name", { length: 255 }),
    anchor: jsonb("anchor").$type<Record<string, unknown>>(),
    body: text("body").notNull(),
    doneVia: jsonb("done_via").$type<Via>(),
    /** When a tag in it first asked the AI, so an edit never asks again */
    aiAskedAt: timestamp("ai_asked_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { mode: "string" }),
  },
  (table) => [index("doc_comments_file_id_idx").on(table.fileId), index("doc_comments_parent_id_idx").on(table.parentId)],
)

/** A comment a user hid from their own view. One per user and comment, enforced in code */
export const docCommentHides = pgTable(
  "doc_comment_hides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => docComments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("doc_comment_hides_comment_user_idx").on(table.commentId, table.userId)],
)

/** A user already told about a mention in a paper's text. One per user and doc, enforced in code */
export const docMentions = pgTable(
  "doc_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    fileId: docColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("doc_mentions_file_user_idx").on(table.fileId, table.userId)],
)

/** A paper or board shown in a call, open until `closed_at` */
export const docCallShares = pgTable(
  "doc_call_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    fileId: docColumn(),
    roomName: varchar("room_name", { length: 255 }).notNull(),
    openedBy: uuid("opened_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** view, comment or edit */
    level: varchar("level", { length: 10 }).notNull(),
    /** Made in the call, so attendees keep the level afterwards */
    forMeeting: boolean("for_meeting").default(false).notNull(),
    eventId: uuid("event_id").references(() => calendarEvents.id, { onDelete: "set null" }),
    occurrenceDate: date("occurrence_date", { mode: "string" }),
    openedAt: timestamp("opened_at", { mode: "string" }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { mode: "string" }),
  },
  (table) => [index("doc_call_shares_room_idx").on(table.roomName, table.closedAt), index("doc_call_shares_file_id_idx").on(table.fileId)],
)

/** A member who connected through an open call share. One per user and share, enforced in code */
export const docCallAttendees = pgTable(
  "doc_call_attendees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    shareId: uuid("share_id")
      .notNull()
      .references(() => docCallShares.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("doc_call_attendees_share_user_idx").on(table.shareId, table.userId)],
)
