import { and, eq, inArray, isNull, ne, or } from "drizzle-orm"
import { z } from "zod"
import { db, docCallShares, fileFolders, fileGrants, fileLinks, groupChats } from "../../db"
import { filterShared } from "../../utils/aiPlace"
import { BOARD_PALETTE, type PaletteName } from "../../utils/boardElements"
import { checkPlan, type BoardPlan, type ItemKind } from "../../utils/boardLayout"
import { canSeeComments } from "../../utils/docAccess"
import { formatRefusal, parseDocText, type Kept } from "../../utils/docFormat"
import { boardLines, lineIsThere, lineText, revisionOf, unitTextAt } from "../../utils/docText"
import { BOARD_FIELD } from "../../utils/docYjs"
import { allSeeComments } from "../aiReach"
import { docAuthors, docFacts, type DocFacts } from "../docAuthors"
import { paperText } from "../docRefs"
import type { CommentThreadDto } from "../docComments"
import { docLevelFor, docPeople } from "../docs"
import { currentDoc, DOC_GONE, editDoc, USE_ADD_TO_BOARD, writeBoard, writeDoc } from "../docWrite"
import { folderAncestors, folderFacts, type FileViewer } from "../files"
import { can } from "../../utils/fileAccess"
import type { FileDto } from "../fileQueries"
import { AppError } from "../acting"
import { logger } from "../../utils/logger"
import { membersOf } from "../tenancy"
import { placeReader } from "./reader"
import {
  call,
  clip,
  joinNames,
  LIST_LIMIT,
  otherAdmins,
  personName,
  projectName,
  projectShared,
  query,
  tool,
  uuid,
  type ToolContext,
} from "./shared"
import { errorText } from "../../utils/errorText"

type TaskDto = { id: string; identifier: string | null; title: string; project?: { name: string } | null }

const WRITE_MAX = 20000
const READ_MAX = 60000
const COMMENT_MAX = 5000

const docRef = (id: string) => ({ kind: "doc" as const, id })
const ref = z
  .string()
  .regex(/^b\d+$/)
  .describe("A block's ref as read_doc shows it, such as b3")
const revision = z
  .string()
  .regex(/^[0-9a-f]{12}$/)
  .describe("The revision read_doc gave")

const viewerOf = (ctx: ToolContext): FileViewer => ({ userId: ctx.askerId, organizationId: ctx.organizationId, isOrgAdmin: ctx.isAdmin })

/** Who may have written the docs, as one list for taint */
const authorsOf = async (organizationId: string, docs: DocFacts[]) => (await docAuthors(organizationId, docs)).flat()

/** The doc when the asker can open it now */
async function reachable(ctx: ToolContext, fileId: string) {
  const { file, level } = await docLevelFor(fileId, viewerOf(ctx))
  return file && level ? { file, level } : null
}

/**
 * Whether a user besides the asker can open the doc: a user it is shared with, a project member or admin, a call, any
 * user a post or comment linking it reaches, or for a project doc any user granted it or a folder above it
 */
async function docShared(ctx: ToolContext, fileId: string): Promise<boolean> {
  const found = await reachable(ctx, fileId)
  if (!found) return true
  const { file } = found
  const people = await docPeople(file, ctx.organizationId)
  if (people.some((person) => person.id !== ctx.askerId)) return true
  if (file.projectId && (await otherAdmins(ctx))) return true
  const [link] = await db
    .select({ id: fileLinks.id })
    .from(fileLinks)
    .where(and(eq(fileLinks.fileId, fileId), eq(fileLinks.organizationId, ctx.organizationId)))
    .limit(1)
  if (link) return true
  if (file.projectId) {
    const folders = file.folderId ? await folderAncestors(file.folderId, ctx.organizationId, db) : []
    const on = folders.length ? or(eq(fileGrants.fileId, fileId), inArray(fileGrants.folderId, folders)) : eq(fileGrants.fileId, fileId)
    const [grant] = await db
      .select({ id: fileGrants.id })
      .from(fileGrants)
      .where(and(on, eq(fileGrants.organizationId, ctx.organizationId), ne(fileGrants.userId, ctx.askerId)))
      .limit(1)
    if (grant) return true
  }
  const [share] = await db
    .select({ id: docCallShares.id })
    .from(docCallShares)
    .where(and(eq(docCallShares.fileId, fileId), eq(docCallShares.organizationId, ctx.organizationId), isNull(docCallShares.closedAt)))
    .limit(1)
  return !!share
}

async function docName(ctx: ToolContext, fileId: string): Promise<string> {
  const found = await reachable(ctx, fileId).catch(() => null)
  return found ? clip(found.file.fileName, 60) : "a paper"
}

/** Refused before any card: a board takes add_to_board */
async function notABoard(ctx: ToolContext, fileId: string): Promise<string | null> {
  const found = await reachable(ctx, fileId)
  return found?.file.docType === "board" ? USE_ADD_TO_BOARD.error : null
}

const cut = (text: string) => (text.length > READ_MAX ? `${text.slice(0, READ_MAX)}\n(cut off)` : text)

const findDocs = tool({
  name: "find_docs",
  area: "papers",
  write: false,
  description: "Find papers and boards the user can open, by name. Leave out the query for the most recent ones.",
  input: z.object({
    query: z.string().trim().min(1).max(100).optional(),
    type: z.enum(["paper", "board"]).optional(),
    projectId: uuid.optional().describe("Only docs in this project"),
  }),
  async run(ctx, args) {
    const types = args.type ? [args.type] : (["paper", "board"] as const)
    const found = await Promise.all(
      types.map((type) =>
        call<{ files: FileDto[] }>(ctx, {
          method: "GET",
          url: `/api/files/search?${query({ q: args.query, type, projectId: args.projectId })}`,
        }),
      ),
    )
    const docs = found
      .flatMap((result) => result.files)
      .filter((file) => file.docType)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, LIST_LIMIT)
    const items = docs.map((file) => ({
      ref: docRef(file.id),
      id: file.id,
      name: file.name,
      type: file.docType,
      owner: file.owner.name,
      project_id: file.projectId,
      updated_at: file.updatedAt,
    }))
    const facts = docs.map((file) => ({ id: file.id, ownerId: file.owner.id, projectId: file.projectId, size: file.size }))
    return { ok: true, data: null, items, authors: await authorsOf(ctx.organizationId, facts) }
  },
})

/** The paper format, for both read_doc and write_doc */
const PAPER_FORMAT = [
  "The paper format, one block per line:",
  "# , ## , ### headings. **bold**, _italic_ or *italic*, <u>underline</u>, ~~strike~~, `code`, <br> for a line break inside a block.",
  "[text](https://...) or mailto: links, and links to Nerla items as [text](task:<id>), (paper:<id>), (board:<id>), (project:<id>) or (file:<id>).",
  "- or * bullets, 1. numbered lines, - [ ] and - [x] checklist lines, nested by two spaces. - [ ] [Title](task:<id>) alone on a checklist line shows that task, and [Hidden task: Title](task:<id>) is one the user can't open, such as a task in the trash, so never treat it as a live task.",
  "> quotes, ``` code blocks with an optional language, --- dividers, and pipe tables with a header row and its | --- | line.",
  "@[Name](person:<id>) mentions someone who can open the paper and tells them.",
  "On a line of their own: ![alt](file:<id>) shows an image from the user's files, ![board](board:<id>) shows a board, ![board](board:new) draws a new board, and ![board](drawn:<id>) is a board already drawn in the paper.",
  "A backslash before a character keeps it as text. A block read as [unsupported: ...] holds something the format can't write.",
].join(" ")

const readDoc = tool({
  name: "read_doc",
  area: "papers",
  write: false,
  description: `Read a paper or board. A paper comes as one [b{n}] line per block with a revision to pass to write_doc, and a block can run over several lines. A board comes as one [e{n}] line per element, top to bottom, with its kind, colour and text, and a revision to pass to add_to_board. ${PAPER_FORMAT}`,
  input: z.object({ fileId: uuid }),
  async run(ctx, args) {
    const found = await reachable(ctx, args.fileId)
    if (!found) return DOC_GONE
    const { file, level } = found
    const doc = await currentDoc(file, ctx.organizationId)
    let text: string
    let rev: string
    try {
      rev = revisionOf(doc)
      text =
        file.docType === "board" ? boardLines(doc.getMap<unknown>(BOARD_FIELD)) : await paperText(doc, ctx.organizationId, viewerOf(ctx))
    } finally {
      doc.destroy()
    }
    const comments = canSeeComments(level) && (!ctx.audience || (await allSeeComments(ctx.organizationId, ctx.audience, file.id)))
    const threads = comments
      ? (await call<{ threads: CommentThreadDto[] }>(ctx, { method: "GET", url: `/api/papers/${file.id}/comments` })).threads
      : []
    const comment = (dto: CommentThreadDto["root"]) => ({
      id: dto.id,
      author: dto.author ? ("name" in dto.author ? dto.author.name : dto.author.guestName) : null,
      body: dto.deleted ? "(deleted)" : dto.body,
      created_at: dto.createdAt,
    })
    const item = {
      ref: docRef(file.id),
      id: file.id,
      name: file.fileName,
      type: file.docType,
      revision: rev,
      level,
      text: cut(text),
      comments: threads.map((thread) => ({ ...comment(thread.root), replies: thread.replies.map(comment) })),
    }
    return { ok: true, data: null, items: [item], authors: await authorsOf(ctx.organizationId, [docFacts(file)]), target: docRef(file.id) }
  },
})

const writeInput = z.object({
  fileId: uuid,
  revision,
  op: z
    .enum(["append", "insert_after", "replace"])
    .describe(
      "append adds at the end, insert_after adds after the block `ref`, replace swaps blocks `from` to `to`. A replace never covers every block of a paper, or a block read as [unsupported: ...]",
    ),
  text: z
    .string()
    .max(WRITE_MAX)
    .describe(
      "A paper's blocks in the paper format read_doc gives, without the [b{n}] refs. At most 20 mentions, 10 images and tables of 50 rows of 10 cells. Empty with replace removes the blocks",
    ),
  ref: ref.optional(),
  from: ref.optional(),
  to: ref.optional(),
})

const writeDocTool = tool({
  name: "write_doc",
  area: "papers",
  write: true,
  description: `Write in a paper. For a board use add_to_board. Read it first and pass its revision. It never replaces a whole paper at once. Anything that can't be written, such as an id the user can't open, stays in the paper as the text written and comes back in kept_as_text with its line and reason, so tell the user or fix it. ${PAPER_FORMAT}`,
  input: writeInput,
  precheck: (ctx, args) => notABoard(ctx, args.fileId),
  async run(ctx, args) {
    let write
    if (args.op === "append") write = { op: "append" as const, text: args.text, revision: args.revision }
    else if (args.op === "insert_after") {
      if (!args.ref) return { ok: false, error: "insert_after needs ref" }
      write = { op: "insert_after" as const, ref: args.ref, text: args.text, revision: args.revision }
    } else {
      if (!args.from || !args.to) return { ok: false, error: "replace needs from and to" }
      write = { op: "replace" as const, from: args.from, to: args.to, text: args.text, revision: args.revision }
    }
    const result = await writeDoc(viewerOf(ctx), args.fileId, write, ctx.via, ctx.requestId)
    if (!result.ok) return result
    return { ok: true, data: { revision: result.revision, kept_as_text: result.kept }, authors: [], target: docRef(result.file.id) }
  },
  // A mention notifies the mentioned user, so another user sees it however the paper is shared
  othersCanSee: async (ctx, args) => parseDocText(args.text).refs.some((ref) => ref.kind === "person") || docShared(ctx, args.fileId),
  async summary(args, ctx) {
    const name = await docName(ctx, args.fileId)
    const text = `"${clip(args.text)}"`
    if (args.op === "append") return `Add to ${name}: ${text}`
    if (args.op === "insert_after") return `Write in ${name} after ${args.ref ?? "a block"}: ${text}`
    if (!args.text.trim()) return `Remove ${args.from ?? "?"} to ${args.to ?? "?"} from ${name}`
    return `Replace ${args.from ?? "?"} to ${args.to ?? "?"} in ${name} with ${text}`
  },
})

/** The text of the checklist line a ref points at */
async function checklistLine(ctx: ToolContext, fileId: string, at: string): Promise<string | null> {
  const found = await reachable(ctx, fileId)
  if (!found || found.file.docType !== "paper") return null
  const doc = await currentDoc(found.file, ctx.organizationId)
  try {
    const line = unitTextAt(doc, at)
    return line?.unit.item?.nodeName === "taskItem" ? lineText(line.unit.item) : null
  } finally {
    doc.destroy()
  }
}

const makeTaskLine = tool({
  name: "make_task_line",
  area: "papers",
  write: true,
  description: "Turn a checklist line of a paper into a task, which then shows on the line. Read the paper first and pass its revision.",
  input: z.object({
    fileId: uuid,
    revision,
    ref,
    projectId: uuid.optional().describe("Leave out for the paper's own project, or one of the user's own tasks"),
    assignee: uuid.optional().describe("A project member to assign"),
  }),
  async run(ctx, args) {
    const result = await editDoc<{ task: TaskDto; linked: boolean }>(
      viewerOf(ctx),
      args.fileId,
      ctx.via,
      ctx.requestId,
      async ({ doc, file, ready, change }) => {
        if (file.docType !== "paper") return { ok: false, error: "Only a paper's checklist lines can become tasks" }
        if (revisionOf(doc) !== args.revision) return { ok: false, error: "The paper changed, read it again" }
        const line = unitTextAt(doc, args.ref)
        const item = line?.unit.item
        if (!line || !item || item.nodeName !== "taskItem") return { ok: false, error: `${args.ref} is not a checklist line` }
        if (item.getAttribute("taskId")) return { ok: false, error: `${args.ref} is a task already` }
        const title = lineText(item)
        if (!title) return { ok: false, error: `${args.ref} has no text to name the task` }
        const projectId = args.projectId ?? file.projectId ?? undefined
        if (!projectId && args.assignee && args.assignee !== ctx.askerId) {
          return { ok: false, error: "A task of the user's own can't be assigned to someone else. Put it in a project first" }
        }
        // The version comes first, and the line is checked again after it, so a task is never made for a line that was removed
        await ready()
        if (!lineIsThere(doc, item) || item.getAttribute("taskId")) return { ok: false, error: "The paper changed, read it again" }
        const task = await call<TaskDto>(ctx, {
          method: "POST",
          url: "/api/tasks",
          body: { title: title.slice(0, 255), project_id: projectId, assigned_to: args.assignee },
        })
        // The line itself rather than its place, so edits made meanwhile never put the task on another line
        const linked = await change((live) => {
          if (!lineIsThere(live, item) || item.getAttribute("taskId")) return { ok: false, error: "The line is gone" }
          item.setAttribute("taskId", task.id)
          return { ok: true }
        })
        return { ok: true, task, linked: linked.ok }
      },
    )
    if (!result.ok) return result
    const { task, linked } = result
    return {
      ok: true,
      data: { task: { id: task.id, identifier: task.identifier, title: task.title }, linked },
      // The task is named after the line, which any of the paper's writers may have written
      authors: await authorsOf(ctx.organizationId, [docFacts(result.file)]),
      target: docRef(result.file.id),
    }
  },
  async othersCanSee(ctx, args) {
    if (args.assignee && args.assignee !== ctx.askerId) return true
    if (await docShared(ctx, args.fileId)) return true
    const projectId = args.projectId ?? (await reachable(ctx, args.fileId))?.file.projectId
    return projectId ? projectShared(ctx, projectId) : false
  },
  async summary(args, ctx) {
    const line = await checklistLine(ctx, args.fileId, args.ref).catch(() => null)
    const where = args.projectId ? ` in the project ${clip(await projectName(ctx, args.projectId), 60)}` : ""
    const who = args.assignee ? `, assigned to ${await personName(ctx, args.assignee)}` : ""
    return `Make a task of ${line ? `"${clip(line)}"` : args.ref} in ${await docName(ctx, args.fileId)}${where}${who}`
  },
})

/** The text of the comment a reply answers, through the asker's own access */
async function parentComment(ctx: ToolContext, fileId: string, commentId: string): Promise<string | null> {
  try {
    const { threads } = await call<{ threads: CommentThreadDto[] }>(ctx, { method: "GET", url: `/api/papers/${fileId}/comments` })
    const found = threads.flatMap((thread) => [thread.root, ...thread.replies]).find((comment) => comment.id === commentId)
    return found && !found.deleted ? found.body : null
  } catch {
    return null
  }
}

const addDocComment = tool({
  name: "add_doc_comment",
  area: "papers",
  write: true,
  description: "Comment on a paper or board, or reply to a comment with parentId.",
  input: z.object({
    fileId: uuid,
    body: z.string().trim().min(1).max(COMMENT_MAX),
    parentId: uuid.optional().describe("The comment to reply to"),
  }),
  async run(ctx, args) {
    const comment = await call<{ id: string; createdAt: string }>(ctx, {
      method: "POST",
      url: `/api/papers/${args.fileId}/comments`,
      body: { body: args.body, ...(args.parentId ? { parentId: args.parentId } : {}) },
    })
    return { ok: true, data: { id: comment.id, created_at: comment.createdAt }, authors: [], target: docRef(args.fileId) }
  },
  async othersCanSee() {
    return true
  },
  async summary(args, ctx) {
    const name = await docName(ctx, args.fileId)
    if (!args.parentId) return `Comment on ${name}: "${clip(args.body)}"`
    const parent = await parentComment(ctx, args.fileId, args.parentId)
    return `Reply to ${parent ? `"${clip(parent, 40)}"` : "a comment"} on ${name}: "${clip(args.body)}"`
  },
})

/** Where a new paper or board goes, and for one made in a group chat that isn't a project chat, who it's shared with */
type Spot = { projectId?: string; folderId?: string; shareWith: string[]; unshared?: boolean }
type PlaceArgs = { projectId?: string; folderId?: string }

const SHARE_BATCH = 50

/**
 * A paper or board asked for in a group chat without a place goes in the chat's project, or for any other group chat
 * in the asker's own files, shared as editors with the chat's members as they were when its card was made
 */
async function spotOf(ctx: ToolContext, args: PlaceArgs): Promise<Spot> {
  const given = { projectId: args.projectId, folderId: args.folderId, shareWith: [] }
  if (args.projectId || args.folderId || ctx.place.kind !== "group") return given
  const [chat] = await db
    .select({ projectId: groupChats.projectId })
    .from(groupChats)
    .where(and(eq(groupChats.id, ctx.place.id), eq(groupChats.organizationId, ctx.organizationId)))
    .limit(1)
  if (!chat) return given
  if (chat.projectId) return { projectId: chat.projectId, shareWith: [] }
  const members = ctx.audience ?? ctx.members
  if (!members) return { shareWith: [], unshared: true }
  return { shareWith: members.filter((id) => id !== ctx.askerId) }
}

/** A personal folder is shared once another user has a grant on it or a folder above it, and a project folder goes with its project */
async function folderShared(ctx: ToolContext, folderId: string): Promise<boolean> {
  const [folder] = await db
    .select({ projectId: fileFolders.projectId })
    .from(fileFolders)
    .where(and(eq(fileFolders.id, folderId), eq(fileFolders.organizationId, ctx.organizationId)))
    .limit(1)
  if (!folder) return true
  if (folder.projectId) return projectShared(ctx, folder.projectId)
  const folders = await folderAncestors(folderId, ctx.organizationId, db)
  if (!folders.length) return true
  const [grant] = await db
    .select({ id: fileGrants.id })
    .from(fileGrants)
    .where(
      and(inArray(fileGrants.folderId, folders), eq(fileGrants.organizationId, ctx.organizationId), ne(fileGrants.userId, ctx.askerId)),
    )
    .limit(1)
  return !!grant
}

async function spotShared(ctx: ToolContext, spot: Spot): Promise<boolean> {
  if (spot.shareWith.length) return true
  if (spot.folderId) return folderShared(ctx, spot.folderId)
  return spot.projectId ? projectShared(ctx, spot.projectId) : false
}

const placeShared = async (ctx: ToolContext, args: PlaceArgs) => spotShared(ctx, await spotOf(ctx, args))

/** The folder's name only when the asker can open it, so a card never shows a name they couldn't see */
async function folderName(ctx: ToolContext, folderId: string): Promise<string> {
  const loaded = await folderFacts(folderId, { userId: ctx.askerId, organizationId: ctx.organizationId, isOrgAdmin: ctx.isAdmin }, db)
  return loaded && can("view", loaded.facts, loaded.viewer) ? `the folder ${clip(loaded.folder.name, 60)}` : "a folder"
}

async function chatTitle(ctx: ToolContext, chatId: string): Promise<string> {
  const [chat] = await db
    .select({ name: groupChats.name })
    .from(groupChats)
    .where(and(eq(groupChats.id, chatId), eq(groupChats.organizationId, ctx.organizationId)))
    .limit(1)
  return chat ? clip(chat.name, 60) : "this chat"
}

/** Where it goes, as the card says it, and a note when not everyone in the chat it was asked in can open the project */
async function spotText(ctx: ToolContext, spot: Spot): Promise<string> {
  if (spot.shareWith.length && ctx.place.kind === "group") {
    return `in your files, shared with everyone in ${await chatTitle(ctx, ctx.place.id)} so they can edit it`
  }
  if (spot.folderId) return `in ${await folderName(ctx, spot.folderId)}`
  if (!spot.projectId) return "in your files"
  // "the project" first, so a project named "your files" never reads like the asker's own files
  const name = clip(await projectName(ctx, spot.projectId), 60)
  if (ctx.place.kind !== "group" || !ctx.audience) return `in the project ${name}`
  const ref = { kind: "project" as const, id: spot.projectId }
  const open = await filterShared([{ ref }], ctx.audience, placeReader(ctx.organizationId, ctx.audience))
  return open.length ? `in the project ${name}` : `in the project ${name} (not everyone in this chat can open it)`
}

/** Shares a new paper or board with the members of the group chat it was asked in, through the app's own sharing */
async function shareDoc(ctx: ToolContext, fileId: string, kind: "paper" | "board", spot: Spot): Promise<string | null> {
  const unshared = `The ${kind} is in your files, but it couldn't be shared with the chat. Share it from its Share button`
  if (spot.unshared) return unshared
  let shared = 0
  try {
    const userIds = [...(await membersOf(ctx.organizationId, spot.shareWith))]
    for (let at = 0; at < userIds.length; at += SHARE_BATCH) {
      const batch = userIds.slice(at, at + SHARE_BATCH)
      await call(ctx, { method: "POST", url: `/api/files/${fileId}/grants`, body: { userIds: batch, level: "edit" } })
      shared += batch.length
    }
    return null
  } catch (error) {
    logger.warn("Sharing a new doc with a chat failed", { kind, shared, error: errorText(error) })
    const why = error instanceof AppError ? ` (${error.message})` : ""
    if (!shared) return `The ${kind} is in your files, but it couldn't be shared with the chat${why}. Share it from its Share button`
    return `The ${kind} is in your files and shared with ${count(shared, "person", "people")} of the chat, but not the rest${why}. Share it from its Share button`
  }
}

/** Makes the paper or board where the spot says, shared with the chat when it should be */
async function makeDoc(
  ctx: ToolContext,
  kind: "paper" | "board",
  name: string,
  spot: Spot,
): Promise<{ file: FileDto; problems: string[] }> {
  const file = await call<FileDto>(ctx, {
    method: "POST",
    url: "/api/papers",
    body: { docType: kind, name, projectId: spot.projectId, folderId: spot.folderId },
  })
  const problem = spot.shareWith.length || spot.unshared ? await shareDoc(ctx, file.id, kind, spot) : null
  return { file, problems: problem ? [problem] : [] }
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const KIND_WORDS: Record<ItemKind, string> = {
  note: "note",
  text: "text",
  heading: "heading",
  rectangle: "shape",
  ellipse: "shape",
  diamond: "shape",
}

/** "24 notes in 5 clusters and 9 arrows" */
function planText(plan: BoardPlan): string {
  const kinds = new Map<string, number>()
  for (const item of plan.items) kinds.set(KIND_WORDS[item.kind], (kinds.get(KIND_WORDS[item.kind]) ?? 0) + 1)
  const items = joinNames([...kinds].map(([one, n]) => count(n, one)))
  const used = new Set(plan.items.map((item) => item.group))
  const groups = plan.groups.filter((group) => used.has(group.id)).length
  const shape =
    plan.layout === "mind_map"
      ? " as a mind map"
      : plan.layout === "flow"
        ? " as a flow"
        : groups
          ? ` in ${count(groups, plan.layout === "columns" ? "column" : "cluster")}`
          : ""
  const arrows = plan.connections.filter((link) => link.kind === "arrow").length
  const lines = plan.connections.length - arrows
  const links = [arrows ? count(arrows, "arrow") : "", lines ? count(lines, "line") : ""].filter(Boolean)
  return joinNames([`${items}${shape}`, ...links])
}

const PALETTE_NAMES = Object.keys(BOARD_PALETTE) as [PaletteName, ...PaletteName[]]
const KINDS = ["note", "text", "heading", "rectangle", "ellipse", "diamond"] as const
const shortId = z.string().trim().min(1).max(40)

// Loose bounds here, so the caps are refused in checkPlan's plain words before any card
const planInput = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          id: shortId.describe("Your own short id for the item, such as n1"),
          kind: z
            .enum(KINDS)
            .describe("note is a sticky note, heading a large text, rectangle, ellipse and diamond a shape with the text inside"),
          text: z.string().max(2000).describe("Plain text, at most 280 characters, 80 for a heading"),
          color: z.enum(PALETTE_NAMES).optional().describe("Notes and shapes only. Notes are lemon and shapes sky unless given"),
          group: shortId.optional().describe("The id of its group"),
        }),
      )
      .max(500)
      .describe("At most 60 items"),
    groups: z
      .array(
        z.strictObject({
          id: shortId,
          title: z.string().max(500).optional().describe("At most 80 characters"),
          frame: z.boolean().optional().describe("Draw a frame around the group, named by its title"),
        }),
      )
      .max(100)
      .default([])
      .describe("At most 12 groups"),
    connections: z
      .array(
        z.strictObject({
          from: shortId,
          to: shortId,
          kind: z.enum(["arrow", "line"]),
          label: z.string().max(500).optional().describe("At most 60 characters"),
        }),
      )
      .max(500)
      .default([])
      .describe("At most 80, between items of this call only"),
    layout: z
      .enum(["clusters", "mind_map", "columns", "flow"])
      .describe(
        "clusters keeps each group together by theme, mind_map places everything around center, columns makes one column per group in order, flow runs left to right in order",
      ),
    center: shortId.optional().describe("For mind_map, the id of the item in the middle, which has no group"),
  })
  .describe(
    "The board's content as structure, never coordinates. The server lays it out so nothing overlaps, beside anything already there. Text is plain and marks stay as typed. Colours are lemon, sky, pistachio, lavender and bubblegum, for notes and shapes only.",
  )

const pathOf = (kind: "paper" | "board", id: string) => `/${kind}/${id}`

const placeInput = {
  name: z.string().trim().min(1).max(255),
  projectId: uuid.optional().describe("A project the user is a member of"),
  folderId: uuid.optional().describe("A folder the user can add to. Leave both out for the user's own files"),
}

const createPaper = tool({
  name: "create_paper",
  area: "papers",
  write: true,
  description: `Create a paper in a project, a folder or the user's own files, with optional starting content. In a group chat, leave the place out to use the chat's project, or for any other group chat the user's own files shared with everyone in it. Link it in your answer as [its name](its path). Anything that can't be written stays as text and comes back in kept_as_text. ${PAPER_FORMAT}`,
  input: z.object({
    ...placeInput,
    content: z
      .string()
      .max(WRITE_MAX)
      .optional()
      .describe("Starting blocks in the paper format. At most 20 mentions, 10 images and tables of 50 rows of 10 cells"),
  }),
  alwaysGated: (args, ctx) => placeShared(ctx, args),
  placeData: ["name", "kind", "path", "problems", "kept_count"],
  async precheck(_ctx, args) {
    return args.content?.trim() ? formatRefusal(parseDocText(args.content).nodes) : null
  },
  async run(ctx, args) {
    const { file, problems } = await makeDoc(ctx, "paper", args.name, await spotOf(ctx, args))
    let kept: Kept[] = []
    if (args.content?.trim()) {
      const written = await writeDoc(
        viewerOf(ctx),
        file.id,
        { op: "append", text: args.content, revision: "" },
        ctx.via,
        ctx.requestId,
        true,
      )
      if (written.ok) kept = written.kept
      else problems.push(`The paper was made, but its content couldn't be written: ${written.error}`)
    }
    const data = {
      id: file.id,
      name: file.name,
      kind: "paper",
      path: pathOf("paper", file.id),
      ...(kept.length ? { kept_as_text: kept, kept_count: kept.length } : {}),
      ...(problems.length ? { problems } : {}),
    }
    return { ok: true, data, authors: [], target: docRef(file.id) }
  },
  // A mention notifies the mentioned user, as in write_doc
  othersCanSee: async (ctx, args) =>
    (!!args.content && parseDocText(args.content).refs.some((ref) => ref.kind === "person")) || placeShared(ctx, args),
  async summary(args, ctx) {
    return `Create paper ${clip(args.name, 80)} ${await spotText(ctx, await spotOf(ctx, args))}`
  },
})

const createBoard = tool({
  name: "create_board",
  area: "papers",
  write: true,
  description:
    "Create a board in a project, a folder or the user's own files, optionally filled with notes, texts, shapes, frames and connections that the server lays out. In a group chat, leave the place out to use the chat's project, or for any other group chat the user's own files shared with everyone in it. Link it in your answer as [its name](its path).",
  input: z.object({ ...placeInput, plan: planInput.optional() }),
  alwaysGated: (args, ctx) => placeShared(ctx, args),
  placeData: ["name", "kind", "path", "problems"],
  precheck: async (_ctx, args) => (args.plan ? checkPlan(args.plan) : null),
  async run(ctx, args) {
    const { file, problems } = await makeDoc(ctx, "board", args.name, await spotOf(ctx, args))
    if (args.plan) {
      const written = await writeBoard(viewerOf(ctx), file.id, args.plan, null, ctx.via, ctx.requestId)
      if (!written.ok) problems.push(`The board was made, but its content couldn't be placed: ${written.error}`)
    }
    const data = { id: file.id, name: file.name, kind: "board", path: pathOf("board", file.id), ...(problems.length ? { problems } : {}) }
    return { ok: true, data, authors: [], target: docRef(file.id) }
  },
  othersCanSee: placeShared,
  async summary(args, ctx) {
    const where = await spotText(ctx, await spotOf(ctx, args))
    return `Create board ${clip(args.name, 80)} ${where}${args.plan ? `, with ${planText(args.plan)}` : ""}`
  },
})

const addToBoard = tool({
  name: "add_to_board",
  area: "papers",
  write: true,
  description:
    "Add notes, texts, shapes, frames and connections to a board. Read it first and pass its revision. The new content goes beside what is there, which never moves or changes. Connections join items of this call only, so to link to something already there, ask the user to draw it.",
  input: z.object({ fileId: uuid, revision, plan: planInput }),
  alwaysGated: (args, ctx) => docShared(ctx, args.fileId),
  async precheck(ctx, args) {
    const found = await reachable(ctx, args.fileId)
    if (!found) return null
    if (found.file.docType !== "board") return "That is a paper. Use write_doc for papers"
    if (found.level !== "edit") return "Only people who can edit this board can add to it"
    const doc = await currentDoc(found.file, ctx.organizationId)
    try {
      if (revisionOf(doc) !== args.revision) return "The board changed, read it again"
    } finally {
      doc.destroy()
    }
    return checkPlan(args.plan)
  },
  async run(ctx, args) {
    const written = await writeBoard(viewerOf(ctx), args.fileId, args.plan, args.revision, ctx.via, ctx.requestId)
    if (!written.ok) return written
    return {
      ok: true,
      data: { revision: written.revision, path: pathOf("board", written.file.id) },
      authors: [],
      target: docRef(written.file.id),
    }
  },
  othersCanSee: (ctx, args) => docShared(ctx, args.fileId),
  async summary(args, ctx) {
    return `Add to ${await docName(ctx, args.fileId)}: ${planText(args.plan)}`
  },
})

export const DOC_TOOLS = [findDocs, readDoc, writeDocTool, makeTaskLine, addDocComment, createPaper, createBoard, addToBoard]
