import { and, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { aiRequests, db, groupChats } from "../../db"
import { dmRef } from "../../utils/aiPlace"
import { localMinute, storedMs } from "../../utils/eventTime"
import type { MessageDto } from "../chats"
import { call, clip, LIST_LIMIT, nameOf, namesOf, ownTimeZone, query, textAuthor, toInstant, tool, uuid, type ToolContext } from "./shared"

type ChatSummary = {
  kind: "dm" | "group"
  id: string
  title: string
  project_id: string | null
  member_count: number
  unread: boolean
  last_activity_at: string
}

const MESSAGE_LIMIT = 30

const chatRef = (ctx: ToolContext, kind: "dm" | "group", id: string) =>
  kind === "dm" ? dmRef(ctx.askerId, id) : { kind: "chat" as const, id }

/** What a call changed or read, for the activity log: the group, or the user a DM is with */
const chatTarget = (kind: "dm" | "group", id: string) => ({ kind: kind === "dm" ? ("person" as const) : ("chat" as const), id })

const chatInput = {
  kind: z.enum(["group", "dm"]).describe("A group chat, or a DM with one person"),
  id: uuid.describe("The group chat's id, or for a DM the other person's id"),
}

/**
 * Who could have set each title: a DM's is the other user's name, and a group's any member unless the asker
 * made it and is alone in it. A project chat is named after its project, which any of its admins can rename
 */
async function chatTitleAuthors(ctx: ToolContext, chats: ChatSummary[]): Promise<(string | null)[]> {
  const groups = chats.filter((chat) => chat.kind === "group")
  const solo = groups.filter((chat) => chat.member_count <= 1 && !chat.project_id).map((chat) => chat.id)
  const own = solo.length
    ? await db
        .select({ id: groupChats.id })
        .from(groupChats)
        .where(and(inArray(groupChats.id, solo), eq(groupChats.organizationId, ctx.organizationId), eq(groupChats.createdBy, ctx.askerId)))
    : []
  const mine = new Set(own.map((row) => row.id))
  return chats.map((chat) => (chat.kind === "dm" ? chat.id : mine.has(chat.id) ? ctx.askerId : null))
}

const listChats = tool({
  name: "list_chats",
  area: "chat",
  write: false,
  description: "List the user's group chats and DMs, most recent first.",
  input: z.object({}),
  async run(ctx) {
    const rows = await call<ChatSummary[]>(ctx, { method: "GET", url: "/api/chats" })
    const shown = rows.slice(0, LIST_LIMIT)
    const items = shown.map((chat) => ({
      ref: chatRef(ctx, chat.kind, chat.id),
      kind: chat.kind,
      id: chat.id,
      title: chat.title,
      member_count: chat.member_count,
      unread: chat.unread,
      last_activity_at: chat.last_activity_at,
    }))
    return { ok: true, data: null, items, authors: await chatTitleAuthors(ctx, shown) }
  },
})

/** A page of read_chat, and the most it gives back in one request */
const CHAT_PAGE = 50
const CHAT_READ_MAX = 200
const AT_CAP = "That's as far back as I can read in one go. Answer from the messages you have read and don't read this chat again"

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_FRACTION = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\.\d+$/
/** The oldest message of a page, and the since cutoff in milliseconds when the page had one */
const CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_(\d{1,15}))?$/

/** A date, or a date and time, read in the asker's zone, as the instant a since range starts */
export function sinceInstant(value: string, zone: string): string | null {
  const local = DATE_ONLY.test(value) ? `${value}T00:00` : value.replace(LOCAL_FRACTION, "$1")
  const ms = storedMs(toInstant(local, zone))
  return ms === null ? null : new Date(ms).toISOString()
}

/** How much of a page still fits under the request's cap */
export const pageWithin = (read: number, page: number, cap = CHAT_READ_MAX) => Math.max(0, Math.min(page, cap - read))

const cursorOf = (message: MessageDto, from: number | null) =>
  `${message.created_at.replace(" ", "T")}_${message.id}${from === null ? "" : `_${from}`}`

const requestRow = (ctx: ToolContext, organizationId: string) =>
  and(eq(aiRequests.id, ctx.requestId), eq(aiRequests.organizationId, organizationId), eq(aiRequests.userId, ctx.askerId))

/** Takes up to `want` reads from the request's allowance, locked so calls side by side can't pass the cap together */
function takeReads(ctx: ToolContext, want: number): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ read: aiRequests.chatRead }).from(aiRequests).where(requestRow(ctx, ctx.organizationId)).for("update")
    if (!row) return 0
    const granted = pageWithin(row.read, want)
    if (granted)
      await tx
        .update(aiRequests)
        .set({ chatRead: row.read + granted })
        .where(requestRow(ctx, ctx.organizationId))
    return granted
  })
}

async function giveBack(ctx: ToolContext, unused: number): Promise<void> {
  if (unused <= 0) return
  await db
    .update(aiRequests)
    .set({ chatRead: sql`greatest(${aiRequests.chatRead} - ${unused}, 0)` })
    .where(requestRow(ctx, ctx.organizationId))
}

const readChat = tool({
  name: "read_chat",
  area: "chat",
  write: false,
  description: `Read messages of a group chat or DM the user is in, oldest first. Give at most one range: the last N messages, every message since a time, or the messages around a message id. With none it gives the last ${MESSAGE_LIMIT}. Times are the user's local time. A page holds up to ${CHAT_PAGE} messages, and one request (one session over MCP) reads at most ${CHAT_READ_MAX}. While older messages remain it answers next_before, which you pass back as before to read the page before it, keeping a since range.`,
  input: z.object({
    ...chatInput,
    last: z.number().int().min(1).max(CHAT_PAGE).optional().describe("The newest N messages"),
    since: z
      .string()
      .max(40)
      .optional()
      .describe(
        "Every message from this time on, as a date such as 2026-11-02 or a date and time such as 2026-11-02T09:00 in the user's time zone. Turn words such as today or since Monday into a date",
      ),
    around: uuid.optional().describe("A message id, to read the messages around it"),
    before: z.string().max(80).optional().describe("The next_before of the page you read last, to read further back"),
  }),
  async run(ctx, args) {
    if ([args.last, args.since, args.around].filter((value) => value !== undefined).length > 1) {
      return { ok: false, error: "Give one of last, since or around" }
    }
    if (args.around && args.before) return { ok: false, error: "Use before with last or since, or on its own" }
    const cursor = args.before === undefined ? null : CURSOR.exec(args.before)
    if (args.before !== undefined && !cursor) return { ok: false, error: "Pass the next_before of the last page as before" }
    const zone = await ownTimeZone(ctx)
    const since = args.since === undefined ? null : sinceInstant(args.since, zone)
    if (args.since !== undefined && !since) {
      return { ok: false, error: "Give since as a date such as 2026-11-02, or a date and time such as 2026-11-02T09:00" }
    }

    const from = since ? Date.parse(since) : cursor?.[3] ? Number(cursor[3]) : null

    const target = chatTarget(args.kind, args.id)
    const want = args.last ?? (since || cursor || args.around ? CHAT_PAGE : MESSAGE_LIMIT)
    const granted = await takeReads(ctx, want)
    if (!granted) return { ok: true, data: { note: AT_CAP }, items: [], authors: [], target }
    let kept = 0
    try {
      const base = args.kind === "group" ? `/api/group-chats/${args.id}/messages` : `/api/messages/conversation/${args.id}`
      const range = args.around ? { around: args.around } : { before: cursor?.[1], beforeId: cursor?.[2] }
      const rows = await call<MessageDto[]>(ctx, { method: "GET", url: `${base}?${query({ ...range, limit: granted })}` })
      const inRange = from === null ? rows : rows.filter((message) => (storedMs(message.created_at) ?? 0) >= from)
      const messages = inRange.filter((message) => message.kind !== "call")
      kept = messages.length
      const more = rows.length > 0 && rows.length === granted && inRange.length === rows.length
      const ref = chatRef(ctx, args.kind, args.id)
      const items = messages.map((message) => ({
        ref,
        id: message.id,
        sender_id: message.sender_id,
        sender: nameOf(message.sender),
        content: message.content,
        created_at: localMinute(message.created_at, zone),
      }))
      const data = !more ? null : granted < want ? { note: AT_CAP } : { next_before: cursorOf(rows[0], from) }
      return { ok: true, data, items, authors: messages.map((message) => textAuthor(message.sender_id, message.done_via)), target }
    } finally {
      await giveBack(ctx, granted - kept)
    }
  },
})

const postMessage = tool({
  name: "post_message",
  area: "chat",
  write: true,
  alwaysGated: () => true,
  description: "Post a message in a group chat or DM the user is in.",
  input: z.object({ ...chatInput, content: z.string().trim().min(1).max(4000) }),
  async run(ctx, args) {
    const message = await call<MessageDto>(ctx, {
      method: "POST",
      url: args.kind === "group" ? `/api/group-chats/${args.id}/messages` : "/api/messages",
      body: args.kind === "group" ? { content: args.content } : { recipientId: args.id, content: args.content },
    })
    return { ok: true, data: { id: message.id, created_at: message.created_at }, authors: [], target: chatTarget(args.kind, args.id) }
  },
  async othersCanSee() {
    return true
  },
  async summary(args, ctx) {
    const text = `"${clip(args.content)}"`
    if (args.kind === "dm") return `Message ${(await namesOf(ctx, [args.id])).get(args.id) ?? "someone"}: ${text}`
    const chats = await call<ChatSummary[]>(ctx, { method: "GET", url: "/api/chats" }).catch(() => [])
    const chat = chats.find((row) => row.kind === "group" && row.id === args.id)
    return `Post in ${chat ? clip(chat.title, 60) : "a group chat"}: ${text}`
  },
})

export const CHAT_TOOLS = [listChats, readChat, postMessage]
