import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { db, docCommentHides, docComments, users } from "../db"
import type { Via } from "../utils/aiTypes"
import { serverInstant } from "../utils/chatAccess"
import { canSeeComments } from "../utils/docAccess"
import { visibleThreads, type CommentAnchor, type Thread } from "../utils/docComments"
import { addedMentions, parseMentions } from "../utils/mentions"
import { presenceName } from "../utils/presence"
import { notifyComments } from "./collab"
import { docLevelFor, type DocRow } from "./docs"
import type { FileViewer } from "./files"
import { notify } from "./notifications"

export type CommentRow = typeof docComments.$inferSelect

type CommentAuthor = { id: string; name: string; avatarUrl: string | null } | { guestName: string }

export type CommentDto = {
  id: string
  parentId: string | null
  /** Null when the comment was deleted or its author is gone */
  author: CommentAuthor | null
  body: string
  anchor: CommentAnchor | null
  createdAt: string
  updatedAt: string
  deleted: boolean
  mine: boolean
  done_via: Via | null
}

export type CommentThreadDto = Thread<CommentDto>

/** Who reads or writes: a member, or a guest in a call, who has no id and hides nothing. `via` marks a write through an agent or the AI */
type Commenter = { organizationId: string; userId: string | null; guestName?: string; via?: Via | null }

const iso = (value: string) => new Date(serverInstant(value)).toISOString()

/** The paper or board when the viewer can see its comments. Viewers and users without a level get nothing */
export async function commentsDoc(fileId: string, viewer: FileViewer, shareId?: string): Promise<DocRow | null> {
  const { file, level } = await docLevelFor(fileId, viewer, undefined, { shareId })
  return file && canSeeComments(level) ? file : null
}

/** A comment in the workspace, deleted or not */
export async function findComment(commentId: string, organizationId: string): Promise<CommentRow | null> {
  const [row] = await db
    .select()
    .from(docComments)
    .where(and(eq(docComments.id, commentId), eq(docComments.organizationId, organizationId)))
  return row ?? null
}

async function toDtos(rows: CommentRow[], viewer: Commenter): Promise<Map<string, CommentDto>> {
  const ids = [...new Set(rows.flatMap((row) => (row.authorId && !row.deletedAt ? [row.authorId] : [])))]
  const people = ids.length
    ? await db
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, avatarUrl: users.avatarUrl })
        .from(users)
        .where(inArray(users.id, ids))
    : []
  const byId = new Map(people.map((person) => [person.id, person]))
  return new Map(
    rows.map((row) => {
      const person = row.authorId ? byId.get(row.authorId) : undefined
      const author: CommentAuthor | null = row.deletedAt
        ? null
        : person
          ? { id: person.id, name: presenceName(person.firstName, person.lastName), avatarUrl: person.avatarUrl }
          : row.guestName
            ? { guestName: row.guestName }
            : null
      const dto: CommentDto = {
        id: row.id,
        parentId: row.parentId,
        author,
        body: row.deletedAt ? "" : row.body,
        anchor: (row.anchor as CommentAnchor | null) ?? null,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
        deleted: !!row.deletedAt,
        mine: !!row.authorId && row.authorId === viewer.userId,
        done_via: row.doneVia ?? null,
      }
      return [row.id, dto]
    }),
  )
}

/** The doc's threads as the viewer sees them, oldest first */
export async function listThreads(file: DocRow, viewer: Commenter): Promise<CommentThreadDto[]> {
  const { organizationId, userId } = viewer
  const [rows, hides] = await Promise.all([
    db
      .select()
      .from(docComments)
      .where(and(eq(docComments.fileId, file.id), eq(docComments.organizationId, organizationId)))
      .orderBy(asc(docComments.createdAt), asc(docComments.id)),
    userId
      ? db
          .select({ commentId: docCommentHides.commentId })
          .from(docCommentHides)
          .innerJoin(docComments, eq(docComments.id, docCommentHides.commentId))
          .where(
            and(eq(docCommentHides.userId, userId), eq(docCommentHides.organizationId, organizationId), eq(docComments.fileId, file.id)),
          )
      : [],
  ])
  const threads = visibleThreads(rows, new Set(hides.map((hide) => hide.commentId)))
  const dtos = await toDtos(
    threads.flatMap((thread) => [thread.root, ...thread.replies]),
    viewer,
  )
  return threads.map((thread) => ({ root: dtos.get(thread.root.id)!, replies: thread.replies.map((reply) => dtos.get(reply.id)!) }))
}

/** The root a reply joins, while its thread still shows: a deleted root only while it has replies */
async function replyRoot(file: DocRow, parentId: string, organizationId: string): Promise<string | null> {
  const [parent] = await db
    .select({ id: docComments.id, parentId: docComments.parentId })
    .from(docComments)
    .where(and(eq(docComments.id, parentId), eq(docComments.fileId, file.id), eq(docComments.organizationId, organizationId)))
  if (!parent) return null
  const rootId = parent.parentId ?? parent.id
  const thread = await db
    .select({ id: docComments.id, parentId: docComments.parentId, deletedAt: docComments.deletedAt })
    .from(docComments)
    .where(
      and(
        eq(docComments.organizationId, organizationId),
        eq(docComments.fileId, file.id),
        or(eq(docComments.id, rootId), eq(docComments.parentId, rootId)),
      ),
    )
  return visibleThreads(thread, new Set()).length ? rootId : null
}

type NewComment = { body: string; anchor?: CommentAnchor; parentId?: string }

/**
 * Adds a comment or a reply, then tells the doc's commenters and the users the comment involves. A guest's
 * comment carries their name. Null when the thread is gone
 */
export async function addComment(file: DocRow, viewer: Commenter, input: NewComment): Promise<CommentDto | null> {
  const { organizationId, userId } = viewer
  const parentId = input.parentId ? await replyRoot(file, input.parentId, organizationId) : null
  if (input.parentId && !parentId) return null
  const now = new Date().toISOString()
  const [row] = await db
    .insert(docComments)
    .values({
      organizationId,
      fileId: file.id,
      parentId,
      authorId: userId,
      guestName: userId ? null : (viewer.guestName ?? null),
      anchor: parentId ? null : (input.anchor ?? null),
      body: input.body,
      doneVia: viewer.via ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  notifyComments(file.id)
  // A guest has no id, so the notification has no actor
  void notify(organizationId, {
    type: "doc_comment",
    actorId: userId,
    fileId: file.id,
    commentId: row.id,
    mentions: parseMentions(row.body),
    edited: false,
  })
  return (await toDtos([row], viewer)).get(row.id)!
}

/** Changes the author's own comment and tells only the users it newly mentions */
export async function editComment(comment: CommentRow, viewer: FileViewer, body: string): Promise<CommentDto | null> {
  const { organizationId, userId } = viewer
  const [row] = await db
    .update(docComments)
    .set({ body, updatedAt: new Date().toISOString() })
    .where(and(eq(docComments.id, comment.id), eq(docComments.organizationId, organizationId), isNull(docComments.deletedAt)))
    .returning()
  if (!row) return null
  notifyComments(comment.fileId)
  const mentions = addedMentions(comment.body, row.body)
  if (mentions.length > 0) {
    void notify(organizationId, { type: "doc_comment", actorId: userId, fileId: comment.fileId, commentId: row.id, mentions, edited: true })
  }
  return (await toDtos([row], viewer)).get(row.id)!
}

/** Marks the comment deleted. Its replies stay, under a root that reads as deleted */
export async function deleteComment(comment: CommentRow, organizationId: string): Promise<boolean> {
  const gone = await db
    .update(docComments)
    .set({ deletedAt: new Date().toISOString() })
    .where(and(eq(docComments.id, comment.id), eq(docComments.organizationId, organizationId), isNull(docComments.deletedAt)))
    .returning({ id: docComments.id })
  if (gone.length > 0) notifyComments(comment.fileId)
  return gone.length > 0
}

/** Hides a thread from the viewer alone. Hiding it again changes nothing */
export async function hideThread(comment: CommentRow, viewer: FileViewer): Promise<void> {
  const { organizationId, userId } = viewer
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`doc-comment-hide:${comment.id}:${userId}`}, 0))`)
    const [existing] = await tx
      .select({ id: docCommentHides.id })
      .from(docCommentHides)
      .where(
        and(
          eq(docCommentHides.commentId, comment.id),
          eq(docCommentHides.userId, userId),
          eq(docCommentHides.organizationId, organizationId),
        ),
      )
    if (!existing) await tx.insert(docCommentHides).values({ organizationId, commentId: comment.id, userId })
  })
  notifyComments(comment.fileId)
}
