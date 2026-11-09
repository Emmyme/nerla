import { and, eq, inArray, isNotNull } from "drizzle-orm"
import { z } from "zod"
import { calendarEvents, db, fileAttachments, projects, tasks } from "../../db"
import type { ItemRef, ToolArea, Via } from "../../utils/aiTypes"
import { can } from "../../utils/fileAccess"
import { AppError } from "../acting"
import { loadFileFacts } from "../files"
import type { TrashItem } from "../trashList"
import { call, clip, query, tool, uuid, type ToolContext } from "./shared"

const KINDS = ["task", "event", "doc", "file", "project"] as const
type Kind = (typeof KINDS)[number]

const FILTER: Record<Kind, string> = { task: "tasks", event: "events", doc: "docs", file: "uploads", project: "projects" }
const AREA: Record<Kind, ToolArea> = { task: "tasks", event: "calendar", doc: "papers", file: "files", project: "projects" }
const RESTORE_URL: Record<Kind, (id: string) => string> = {
  task: (id) => `/api/tasks/${id}/restore`,
  event: (id) => `/api/calendar/${id}/restore`,
  doc: (id) => `/api/files/${id}/restore`,
  file: (id) => `/api/files/${id}/restore`,
  project: (id) => `/api/projects/${id}/restore`,
}
const OWN_PLACE: Record<Kind, string> = {
  task: "your own tasks",
  event: "your calendar",
  doc: "your files",
  file: "your files",
  project: "",
}

/** How far back a restore looks for its entry, in pages of Trash */
const LOOKUP_PAGES = 10

type TrashPage = { items: TrashItem[]; nextCursor: string | null }

/** A Trash entry of the asked kind */
const isKind = (kind: Kind, item: TrashItem) => (kind === "doc" ? item.kind === "paper" || item.kind === "board" : item.kind === kind)

const refOf = (kind: Kind, id: string): ItemRef => ({ kind, id })

const whereText = (kind: Kind, item: TrashItem) => (item.where.kind === "own" ? OWN_PLACE[kind] : (item.where.name ?? OWN_PLACE[kind]))

const viaText = (via: Via | null) => (!via ? null : via.kind === "ai" ? "the AI" : `the agent ${via.tokenName}`)

const trashPage = (ctx: ToolContext, kind: Kind, cursor?: string) =>
  call<TrashPage>(ctx, { method: "GET", url: `/api/trash?${query({ kind: FILTER[kind], cursor })}` })

/** Who may have written the listed items' names and the places shown with them, from the rows in Trash */
async function creatorsOf(ctx: ToolContext, kind: Kind, ids: string[]): Promise<(string | null)[]> {
  if (ids.length === 0) return []
  const org = ctx.organizationId
  if (kind === "task") {
    const rows = await db
      .select({ by: tasks.createdBy, projectId: tasks.projectId, createdAt: tasks.createdAt, updatedAt: tasks.updatedAt })
      .from(tasks)
      .where(and(inArray(tasks.id, ids), eq(tasks.organizationId, org), isNotNull(tasks.deletedAt)))
    // A project's name and a project task's title can be written by other members
    return rows.flatMap((row) => [row.by, ...(row.projectId || row.updatedAt !== row.createdAt ? [null] : [])])
  }
  if (kind === "event") {
    const rows = await db
      .select({ by: calendarEvents.createdBy, createdAt: calendarEvents.createdAt, updatedAt: calendarEvents.updatedAt })
      .from(calendarEvents)
      .where(and(inArray(calendarEvents.id, ids), eq(calendarEvents.organizationId, org), isNotNull(calendarEvents.deletedAt)))
    // A workspace admin can rewrite any event
    return rows.flatMap((row) => [row.by, ...(row.updatedAt !== row.createdAt ? [null] : [])])
  }
  if (kind === "project") {
    const rows = await db
      .select({ by: projects.createdBy, via: projects.createdVia, createdAt: projects.createdAt, updatedAt: projects.updatedAt })
      .from(projects)
      .where(and(inArray(projects.id, ids), eq(projects.organizationId, org), isNotNull(projects.deletedAt)))
    return rows.flatMap((row) => [row.via ? null : row.by, ...(row.updatedAt !== row.createdAt ? [null] : [])])
  }
  const rows = await db
    .select({ by: fileAttachments.uploadedBy, projectId: fileAttachments.projectId, nameCopied: fileAttachments.nameCopied })
    .from(fileAttachments)
    .where(and(inArray(fileAttachments.id, ids), eq(fileAttachments.organizationId, org)))
  // A project file can be renamed by any member of its project, and a copy keeps its original's name, so who named those is unknown
  return rows.flatMap((row) => [row.by, ...(row.projectId || row.nameCopied ? [null] : [])])
}

const listTrash = tool({
  name: "list_trash",
  area: "kinds",
  areaOf: (args) => AREA[args.kind],
  write: false,
  ownView: true,
  description:
    "List what the user could restore from the trash, of one kind: task, event, doc (a paper or board), file or project. Each entry says where it was, when and by whom it was deleted, and whether it can be restored now.",
  input: z.object({ kind: z.enum(KINDS) }),
  async run(ctx, args) {
    const page = await trashPage(ctx, args.kind)
    const found = page.items.filter((item) => isKind(args.kind, item))
    const items = found.map((item) => ({
      ref: refOf(args.kind, item.id),
      kind: args.kind,
      ...(item.kind !== args.kind ? { type: item.kind } : {}),
      id: item.id,
      name: item.name,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(args.kind === "project" ? {} : { was_in: whereText(args.kind, item) }),
      deleted_at: item.deletedAt,
      deleted_by: !item.deletedBy ? null : item.deletedBy.id === ctx.askerId ? "the user" : item.deletedBy.name,
      ...(item.deletedVia ? { deleted_with: viaText(item.deletedVia) } : {}),
      can_restore: item.can.restore,
      ...(item.blocked ? { why_not: item.blocked } : {}),
    }))
    const creators = await creatorsOf(
      ctx,
      args.kind,
      found.map((item) => item.id),
    )
    const note = !found.length
      ? "Nothing of this kind is in the trash"
      : page.nextCursor
        ? "Only the newest entries are shown. Older ones are in the trash for the user to find"
        : null
    return {
      ok: true,
      data: note ? { note } : null,
      items,
      authors: [...creators, ...found.map((item) => item.deletedBy?.id ?? null)],
    }
  },
})

type RestoreArgs = { kind: Kind; id: string }

type Lookup = TrashItem | { error: string }

const NOT_IN_TRASH = "not found in the trash"
const TOO_FAR = "That's further back in the trash than I can look. Ask the user to restore it from the trash"

/** The entry in the asker's own Trash, or why it can't be found */
async function findEntry(ctx: ToolContext, args: RestoreArgs): Promise<Lookup> {
  let cursor: string | undefined
  for (let page = 0; page < LOOKUP_PAGES; page++) {
    const found = await trashPage(ctx, args.kind, cursor)
    const entry = found.items.find((item) => item.id === args.id && isKind(args.kind, item))
    if (entry) return entry
    if (!found.nextCursor) return { error: NOT_IN_TRASH }
    cursor = found.nextCursor
  }
  return { error: TOO_FAR }
}

/** Looked up once per call while it is checked and held. The run after Allow looks again */
const entries = new WeakMap<object, Promise<Lookup>>()
function checkedEntry(ctx: ToolContext, args: RestoreArgs): Promise<Lookup> {
  if (!entries.has(args)) entries.set(args, findEntry(ctx, args))
  return entries.get(args)!
}

/** "With 2 tasks" and "One occurrence on Mon 2 Nov" read on in a sentence. A day such as "Wed 4 Nov" keeps its case */
const midSentence = (text: string) => (/^(With|One|From|Every)\b/.test(text) ? text[0].toLowerCase() + text.slice(1) : text)

const restoreFromTrash = tool({
  name: "restore_from_trash",
  area: "kinds",
  areaOf: (args) => AREA[args.kind],
  write: true,
  ownView: true,
  alwaysGated: () => true,
  description:
    "Bring one entry back from the trash, by its kind and id from list_trash. A project comes back whole, with its tasks and files. It always waits for the user's Allow.",
  input: z.object({ kind: z.enum(KINDS), id: uuid }),
  async precheck(ctx, args) {
    const entry = await checkedEntry(ctx, args)
    if ("error" in entry) return entry.error
    if (entry.blocked) return entry.blocked
    return entry.can.restore ? null : "This can't be restored by the user"
  },
  async run(ctx, args) {
    const entry = await findEntry(ctx, args)
    if ("error" in entry) return { ok: false, error: entry.error }
    if (entry.blocked) return { ok: false, error: entry.blocked }
    const authors = await creatorsOf(ctx, args.kind, [entry.id])
    await call(ctx, { method: "POST", url: RESTORE_URL[args.kind](entry.id) })
    return {
      ok: true,
      data: { kind: entry.kind, id: entry.id, name: entry.name, restored: true },
      authors,
      target: refOf(args.kind, entry.id),
    }
  },
  async summary(args, ctx) {
    const entry = await checkedEntry(ctx, args)
    if ("error" in entry) throw new Error(entry.error)
    const name = clip(entry.name)
    if (args.kind === "project") return `Restore project ${name}${entry.detail ? ` ${midSentence(entry.detail)}` : ""}`
    const detail = args.kind === "event" && entry.detail ? ` (${midSentence(entry.detail)})` : ""
    return `Restore ${entry.kind} ${name}${detail} to ${whereText(args.kind, entry)}`
  },
})

type FileInfo = { id: string; fileName: string }

/** The file through the asker's own access, whether it is a paper or board, and whether they may move it to Trash */
async function loadFile(ctx: ToolContext, fileId: string): Promise<FileInfo & { doc: boolean; mayTrash: boolean }> {
  const file = await call<FileInfo>(ctx, { method: "GET", url: `/api/files/${fileId}` })
  const loaded = await loadFileFacts(file.id, { userId: ctx.askerId, organizationId: ctx.organizationId, isOrgAdmin: ctx.isAdmin })
  if (!loaded) throw new AppError(404, "File not found")
  return { ...file, doc: !!loaded.file.docType, mayTrash: can("trash", loaded.facts, loaded.viewer) }
}

const NO_RIGHT = "The user can open this but can't move it to the trash. Its owner or a member of its project can"
const NOT_A_DOC = "That's an uploaded file, not a paper or board. Use delete_file"
const A_DOC = "That's a paper or board. Use delete_doc"

function deleteTool(name: "delete_doc" | "delete_file", doc: boolean) {
  return tool({
    name,
    area: doc ? "papers" : "files",
    write: true,
    alwaysGated: () => true,
    description: `Move one ${doc ? "paper or board" : "uploaded file"} to the trash, where it can be restored for 30 days. It always waits for the user's Allow.`,
    input: z.object({ fileId: uuid }),
    async precheck(ctx, args) {
      const file = await loadFile(ctx, args.fileId)
      if (file.doc !== doc) return doc ? NOT_A_DOC : A_DOC
      return file.mayTrash ? null : NO_RIGHT
    },
    async run(ctx, args) {
      const file = await loadFile(ctx, args.fileId)
      if (file.doc !== doc) return { ok: false, error: doc ? NOT_A_DOC : A_DOC }
      await call(ctx, { method: "DELETE", url: `/api/files/${file.id}` })
      return {
        ok: true,
        data: { id: file.id, name: file.fileName, in_trash: true },
        authors: await creatorsOf(ctx, doc ? "doc" : "file", [file.id]),
        target: { kind: doc ? "doc" : "file", id: file.id },
      }
    },
    async summary(args, ctx) {
      return `Move ${clip((await loadFile(ctx, args.fileId)).fileName)} to the trash`
    },
  })
}

export const TRASH_TOOL_DEFS = [deleteTool("delete_doc", true), deleteTool("delete_file", false), listTrash, restoreFromTrash]
