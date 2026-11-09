import { and, eq, inArray, ne } from "drizzle-orm"
import { z } from "zod"
import { db, organizationMembers, users } from "../../db"
import type { ItemRef, Place, TokenScopes, ToolArea, Via } from "../../utils/aiTypes"
import { whenIn } from "../../utils/eventNotice"
import { fromWallClock, isValidTimeZone, storedMs } from "../../utils/eventTime"
import { presenceName } from "../../utils/presence"
import { callAs, type AppRequest } from "../acting"
import { memberIdsOf } from "../tenancy"
import { personZone } from "../people"

export type ToolContext = {
  askerId: string
  organizationId: string
  isAdmin: boolean
  via: Via
  requestId: string
  place: Place
  /** Everyone in the shared place the request was made in, or null in the asker's own DM and over MCP */
  audience: string[] | null
  /** The group chat's members when a held change's card was made, for that change once it's allowed */
  members?: string[] | null
  scopes: TokenScopes | null
  signal: AbortSignal
}

export type ToolResult =
  { ok: true; data: unknown; items?: { ref: ItemRef }[]; authors: (string | null)[]; target?: ItemRef } | { ok: false; error: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- one list holds tools of every input type
export type ToolDef<A = any> = {
  name: string
  /** "both" is a batch of other tools' writes, each checked on its own. "kinds" takes its area from its arguments */
  area: ToolArea | "both" | "kinds"
  /** The area a "kinds" tool's call needs */
  areaOf?(args: A): ToolArea
  write: boolean
  /** Offered to the AI teammate alone, never over MCP */
  aiOnly?: boolean
  /** Never offered to a model and never run by name. It names a card in the activity log */
  internal?: boolean
  /** May look things up. A throw counts as gated */
  alwaysGated?: (args: A, ctx: ToolContext) => boolean | Promise<boolean>
  /** Refuses a call in plain words before anything is held, or gives null to go on */
  precheck?(ctx: ToolContext, args: A): Promise<string | null>
  /** Reads the asker's own view, so in a place another user is in it waits until they choose Share in chat */
  ownView?: boolean
  /** The fields of a write's data a shared place may see, such as a new board's path for its link */
  placeData?: string[]
  description: string
  input: z.ZodType<A>
  run(ctx: ToolContext, args: A): Promise<ToolResult>
  othersCanSee?(ctx: ToolContext, args: A): Promise<boolean>
  summary?(args: A, ctx: ToolContext): Promise<string>
}

/** A tool typed by its own input. It refuses fields it doesn't know, so an agent's misspelt field is an error rather than quietly dropped */
export const tool = <S extends z.ZodType>(def: ToolDef<z.infer<S>> & { input: S }): ToolDef => ({
  ...def,
  input: def.input instanceof z.ZodObject ? def.input.strict() : def.input,
})

export const uuid = z.string().uuid()

/** The areas a "kinds" tool can reach */
export const KIND_AREAS: ToolArea[] = ["tasks", "calendar", "papers", "files", "projects"]

/** The area a call needs, or null for a "kinds" tool that can't name one */
export function areaOf(def: ToolDef, args: unknown): ToolArea | "both" | null {
  if (def.area !== "kinds") return def.area
  try {
    return def.areaOf?.(args) ?? null
  } catch {
    return null
  }
}

export const OWN_VIEW_REFUSAL = "This needs your own things. Use ask_private first"

/** How many items a list gives at most */
export const LIST_LIMIT = 50

/** One route call as the asker */
export const call = <T>(ctx: ToolContext, req: AppRequest) =>
  callAs<T>({ id: ctx.askerId, organizationId: ctx.organizationId }, ctx.via, req)

export const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value))
  return search.toString()
}

export const nameOf = (person: { first_name: string | null; last_name: string | null } | null | undefined) =>
  person ? presenceName(person.first_name, person.last_name) : null

/** Workspace members' names by id, for summaries. A user outside the workspace has none */
export async function namesOf(ctx: ToolContext, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(and(inArray(users.id, unique), inArray(users.id, memberIdsOf(ctx.organizationId))))
  return new Map(rows.map((row) => [row.id, presenceName(row.firstName, row.lastName)]))
}

/** A member's name for a summary */
export async function personName(ctx: ToolContext, id: string): Promise<string> {
  return (await namesOf(ctx, [id])).get(id) ?? "someone outside the workspace"
}

/** A project's name for a summary, through the asker's own access */
export async function projectName(ctx: ToolContext, projectId: string): Promise<string> {
  try {
    return (await call<{ name: string }>(ctx, { method: "GET", url: `/api/projects/${projectId}` })).name
  } catch {
    return "a project"
  }
}

/** "Theo", "Theo and Sara" or "Theo, Sara and Ada" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

export async function otherAdmins(ctx: ToolContext): Promise<boolean> {
  const [row] = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, ctx.organizationId),
        eq(organizationMembers.role, "admin"),
        ne(organizationMembers.userId, ctx.askerId),
      ),
    )
    .limit(1)
  return !!row
}

/** Whether a user besides the asker can open the project's tasks and files: another member, or another workspace admin */
export async function projectShared(ctx: ToolContext, projectId: string): Promise<boolean> {
  try {
    const members = await call<{ user_id: string }[]>(ctx, { method: "GET", url: `/api/projects/${projectId}/members` })
    return members.some((member) => member.user_id !== ctx.askerId) || (await otherAdmins(ctx))
  } catch {
    return true
  }
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/

/** A time from the model as a UTC instant. One with Z or an offset stays as it is, a local time is read in `timeZone` */
export function toInstant(value: string, timeZone: string): string {
  const wall = LOCAL_TIME.test(value) ? storedMs(value) : null
  if (wall === null) return value
  return new Date(fromWallClock(wall, isValidTimeZone(timeZone) ? timeZone : "UTC")).toISOString()
}

/** The asker's own time zone */
export const ownTimeZone = (ctx: ToolContext): Promise<string> => personZone(ctx.askerId)

/** A moment in the asker's own time zone, as "Tue 3 Nov 10:00", or "Tue 3 Nov" for a whole day */
export async function whenText(ctx: ToolContext, instant: string, allDay = false): Promise<string> {
  return whenIn(instant, allDay ? "UTC" : await ownTimeZone(ctx), allDay)
}

/** Who wrote a piece of text. What the AI itself said may echo other users from a shared place, so its author is unknown */
export const textAuthor = (userId: string | null, via: Via | null | undefined): string | null =>
  via?.kind === "ai" && via.speaker === "ai" ? null : userId

/** At most `max` characters of a text, for a summary */
export const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
