import { pgTable, uuid, varchar, text, timestamp, primaryKey, index } from "drizzle-orm/pg-core"
import { bytea } from "./columns"
import { organizations, users } from "./users"

export const meetingParticipants = pgTable(
  "meeting_participants",
  {
    roomName: varchar("room_name", { length: 128 }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    invitedBy: uuid("invited_by").references(() => users.id, {
      onDelete: "set null",
    }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roomName, table.userId] }),
    organizationIdx: index("meeting_participants_organization_id_idx").on(table.organizationId),
  }),
)

/** Guests waiting in a call's lobby, kept until expires_at. See src/services/guestSessions.ts */
export const guestSessions = pgTable("guest_sessions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  roomName: text("room_name").notNull(),
  status: text("status").$type<"pending" | "admitted" | "denied" | "cancelled">().notNull(),
  token: text("token"),
  /** The LiveKit identity an admitted guest joins as, which their call pass names */
  identity: text("identity"),
  /** Hosts learn the session id, so the guest's own reads and cancel also need this secret. Only its hash is kept. */
  secretHash: bytea("secret_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
})
