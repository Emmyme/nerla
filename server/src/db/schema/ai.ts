import { pgTable, uuid, varchar, text, timestamp, boolean, integer, bigint, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import type { AiAction, Place, Strictness, ToolArea } from "../../utils/aiTypes"
import { orgColumn } from "./columns"
import { fileAttachments } from "./files"
import { users } from "./users"

/** The workspace's AI and agent settings. One per workspace, enforced in code */
export const aiSettings = pgTable(
  "ai_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    enabled: boolean("enabled").default(false).notNull(),
    mcpEnabled: boolean("mcp_enabled").default(false).notNull(),
    baseUrl: text("base_url"),
    model: varchar("model", { length: 200 }),
    /** The key sealed with AI_MASTER_KEY. Never sent to a client */
    keyCipher: text("key_cipher"),
    keyLast4: varchar("key_last4", { length: 4 }),
    name: varchar("name", { length: 60 }).default("Nerla AI").notNull(),
    avatarFileId: uuid("avatar_file_id").references(() => fileAttachments.id, { onDelete: "set null" }),
    /** In tokens. Null means no cap */
    monthlyBudget: bigint("monthly_budget", { mode: "number" }),
    personBudget: bigint("person_budget", { mode: "number" }),
    allowPersonalKey: boolean("allow_personal_key").default(false).notNull(),
    allowPersonalUrl: boolean("allow_personal_url").default(false).notNull(),
    localNetwork: boolean("local_network").default(false).notNull(),
    strictness: varchar("strictness", { length: 12 }).$type<Strictness>().default("tainted").notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("ai_settings_org_idx").on(table.organizationId)],
)

/** A user's own model, where the workspace allows it. One per user, enforced in code */
export const aiPersonal = pgTable(
  "ai_personal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    baseUrl: text("base_url"),
    model: varchar("model", { length: 200 }),
    keyCipher: text("key_cipher"),
    keyLast4: varchar("key_last4", { length: 4 }),
    strictness: varchar("strictness", { length: 12 }).$type<Strictness>(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("ai_personal_org_user_idx").on(table.organizationId, table.userId)],
)

/** A user's saved preferences for the AI, private to them. One per user, enforced in code */
export const aiPreferences = pgTable(
  "ai_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lines: jsonb("lines").$type<{ id: string; text: string }[]>().default([]).notNull(),
    use: boolean("use").default(true).notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("ai_preferences_org_user_unique").on(table.organizationId, table.userId)],
)

/** An access token for an outside agent. Only its hash is kept */
export const aiTokens = pgTable(
  "ai_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    /** sha256 in hex */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    last4: varchar("last4", { length: 4 }).notNull(),
    scopes: jsonb("scopes").$type<Partial<Record<ToolArea, "read" | "write">>>().notNull(),
    readOnly: boolean("read_only").default(false).notNull(),
    expiresAt: timestamp("expires_at", { mode: "string" }),
    revokedAt: timestamp("revoked_at", { mode: "string" }),
    lastUsedAt: timestamp("last_used_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("ai_tokens_hash_idx").on(table.tokenHash), index("ai_tokens_org_user_idx").on(table.organizationId, table.userId)],
)

/** A user's DM with the AI. One per user, enforced in code */
export const aiThreads = pgTable(
  "ai_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The running summary of the messages that left the history window. Private to the user */
    summary: text("summary"),
    /** The last message folded in, kept when the summary is cleared so nothing older folds again */
    summaryThrough: timestamp("summary_through", { mode: "string" }),
    summaryThroughId: uuid("summary_through_id"),
    summaryAt: timestamp("summary_at", { mode: "string" }),
    summaryTainted: boolean("summary_tainted").default(false).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("ai_threads_org_user_idx").on(table.organizationId, table.userId)],
)

/** One AI turn or one MCP session */
export const aiRequests = pgTable(
  "ai_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** ai or mcp */
    source: varchar("source", { length: 3 }).notNull(),
    tokenId: uuid("token_id").references(() => aiTokens.id, { onDelete: "set null" }),
    place: jsonb("place").$type<Place>().notNull(),
    tainted: boolean("tainted").default(false).notNull(),
    steps: integer("steps").default(0).notNull(),
    /** Chat messages read_chat has given back in this request, capped at CHAT_READ_MAX */
    chatRead: integer("chat_read").default(0).notNull(),
    /** Trash changes held in this request, capped at TRASH_PER_REQUEST */
    trashCount: integer("trash_count").default(0).notNull(),
    status: varchar("status", { length: 12 }).default("running").notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { mode: "string" }),
    /** Written every 30 seconds while a process works on the request, so another process can tell it died */
    heartbeatAt: timestamp("heartbeat_at", { mode: "string", withTimezone: true }),
  },
  (table) => [index("ai_requests_org_user_idx").on(table.organizationId, table.userId)],
)

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => aiThreads.id, { onDelete: "cascade" }),
    /** user or assistant */
    role: varchar("role", { length: 10 }).notNull(),
    content: text("content").notNull(),
    /** done, streaming, stopped or failed */
    status: varchar("status", { length: 10 }).default("done").notNull(),
    requestId: uuid("request_id").references(() => aiRequests.id, { onDelete: "set null" }),
    /** The tool calls an answer's turn made, for the next turns' history. Never shown */
    actions: jsonb("actions").$type<AiAction[]>(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_messages_thread_idx").on(table.threadId, table.createdAt),
    index("ai_messages_streaming_idx")
      .on(table.threadId)
      .where(sql`${table.status} = 'streaming'`),
  ],
)

/** Changes or a share the asker has to allow. `items`, `chosen` and `result` are shaped by the holding code */
export const aiHeld = pgTable(
  "ai_held",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: uuid("request_id")
      .notNull()
      .references(() => aiRequests.id, { onDelete: "cascade" }),
    /** changes, share or reply */
    kind: varchar("kind", { length: 10 }).notNull(),
    items: jsonb("items").$type<unknown[]>().notNull(),
    chosen: jsonb("chosen"),
    result: jsonb("result"),
    /** waiting, allowed, denied, expired or done */
    status: varchar("status", { length: 10 }).default("waiting").notNull(),
    expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    answeredAt: timestamp("answered_at", { mode: "string" }),
    /** A changes card's paused AI turn, so an answer after a restart can still go on */
    resume: jsonb("resume"),
  },
  (table) => [index("ai_held_org_user_idx").on(table.organizationId, table.userId), index("ai_held_request_idx").on(table.requestId)],
)

/** A log of what the AI and agents did, without any content */
export const aiActivity = pgTable(
  "ai_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** ai or mcp */
    source: varchar("source", { length: 3 }).notNull(),
    tokenId: uuid("token_id").references(() => aiTokens.id, { onDelete: "set null" }),
    tool: varchar("tool", { length: 60 }).notNull(),
    targetKind: varchar("target_kind", { length: 20 }),
    targetId: uuid("target_id"),
    /** ok, refused, held, denied or failed */
    result: varchar("result", { length: 10 }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("ai_activity_org_user_idx").on(table.organizationId, table.userId, table.createdAt)],
)

/** Tokens a user used in a month. One per user, month and `personal`, enforced in code */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** YYYY-MM */
    month: varchar("month", { length: 7 }).notNull(),
    tokens: bigint("tokens", { mode: "number" }).default(0).notNull(),
    personal: boolean("personal").default(false).notNull(),
  },
  (table) => [index("ai_usage_org_month_idx").on(table.organizationId, table.month, table.userId)],
)
