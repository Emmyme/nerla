import { randomUUID } from "node:crypto"
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import * as Y from "yjs"
import {
  db,
  docCallAttendees,
  docCallShares,
  docContents,
  fileAttachments,
  fileGrants,
  projectMembers,
  projects,
  users,
  type Executor,
} from "../db"
import { capLevel, DOC_MIME, docLevel, docPath, maxLevel, type DocLevel, type DocType } from "../utils/docAccess"
import type { Via } from "../utils/aiTypes"
import type { GuestDocClaims } from "../utils/docCalls"
import { imageIdsIn, swapImages } from "../utils/docYjs"
import type { FileFacts, ViewerFacts } from "../utils/fileAccess"
import { presenceName } from "../utils/presence"
import { isRefusal } from "../utils/tenancy"
import { liveProject } from "../utils/trash"
import { folderAncestors, loadFileFacts, type FileRow, type FileViewer } from "./files"
import { inRoom, participantIds } from "./liveRooms"
import { collab } from "./collab"
import { membersOf, resolveOrg } from "./tenancy"
import { UUID } from "../utils/uuid"

export type DocRow = FileRow & { docType: DocType }
export type LoadedDoc = { file: DocRow; facts: FileFacts; viewer: ViewerFacts }

/** An empty Yjs update: no structs and no deletions */
export const EMPTY_STATE = Buffer.from([0, 0])

const DEFAULT_NAMES: Record<DocType, string> = { paper: "Untitled paper", board: "Untitled board" }

export const isDoc = (file: FileRow): file is DocRow => file.docType === "paper" || file.docType === "board"

/** The level of the viewer's own grant on the file. A grant on a folder above it gives view, which `hasGrant` carries */
async function fileGrantLevel(fileId: string, viewer: FileViewer, executor: Executor): Promise<DocLevel | null> {
  const rows = await executor
    .select({ level: fileGrants.level })
    .from(fileGrants)
    .where(and(eq(fileGrants.fileId, fileId), eq(fileGrants.userId, viewer.userId), eq(fileGrants.organizationId, viewer.organizationId)))
  return rows.reduce<DocLevel | null>((best, row) => maxLevel(best, row.level as DocLevel), null)
}

/** A share gives no more than its opener can still reach on their own, so taking their access away closes it too */
async function openerCap(
  fileId: string,
  level: DocLevel,
  openedBy: string,
  organizationId: string,
  executor: Executor,
): Promise<DocLevel | null> {
  const own = (await docLevelFor(fileId, await memberViewer(openedBy, organizationId), executor)).level
  return own ? capLevel(level, own) : null
}

/** The level of an open share of this doc, for a user who attended it or is in its call right now */
async function callLevelOf(fileId: string, shareId: string, viewer: FileViewer, executor: Executor): Promise<DocLevel | null> {
  const [share] = await executor
    .select({
      roomName: docCallShares.roomName,
      level: docCallShares.level,
      openedBy: docCallShares.openedBy,
      attendee: docCallAttendees.id,
    })
    .from(docCallShares)
    .leftJoin(
      docCallAttendees,
      and(
        eq(docCallAttendees.shareId, docCallShares.id),
        eq(docCallAttendees.userId, viewer.userId),
        eq(docCallAttendees.organizationId, viewer.organizationId),
      ),
    )
    .where(
      and(
        eq(docCallShares.id, shareId),
        eq(docCallShares.fileId, fileId),
        eq(docCallShares.organizationId, viewer.organizationId),
        isNull(docCallShares.closedAt),
      ),
    )
    .limit(1)
  if (!share || !(share.attendee || (await inRoom(share.roomName, viewer.userId)))) return null
  return openerCap(fileId, share.level as DocLevel, share.openedBy, viewer.organizationId, executor)
}

/** The only place a doc's level is worked out. Anything that is not a paper or board, or not in reach, has no level */
export async function docLevelFor(
  fileId: string,
  viewer: FileViewer,
  executor: Executor = db,
  extra: { shareId?: string } = {},
): Promise<{ file: DocRow | null; loaded: LoadedDoc | null; level: DocLevel | null; callLevel: DocLevel | null }> {
  const found = await loadFileFacts(fileId, viewer, executor)
  if (!found || !isDoc(found.file)) return { file: null, loaded: null, level: null, callLevel: null }
  const file = found.file
  const [grantLevel, callLevel] = await Promise.all([
    found.viewer.hasGrant ? fileGrantLevel(fileId, viewer, executor) : null,
    extra.shareId ? callLevelOf(fileId, extra.shareId, viewer, executor) : null,
  ])
  const level = docLevel({ ...found.facts, docType: file.docType }, { ...found.viewer, grantLevel, callLevel })
  return { file, loaded: { file, facts: found.facts, viewer: found.viewer }, level, callLevel: level ? callLevel : null }
}

/** A member as a live connection or the sweep checks them, with admin rights only in that workspace */
export async function memberViewer(userId: string, organizationId: string): Promise<FileViewer> {
  const org = await resolveOrg(userId)
  return { userId, organizationId, isOrgAdmin: !isRefusal(org) && org.organizationId === organizationId && org.role === "admin" }
}

/** The user's own level, else through any open share of the doc they attended or are in the call of */
export async function reachableLevel(
  fileId: string,
  viewer: FileViewer,
  executor: Executor = db,
): Promise<{ file: DocRow | null; level: DocLevel | null }> {
  const own = await docLevelFor(fileId, viewer, executor)
  if (!own.file || own.level) return own
  const shares = await executor
    .select({ id: docCallShares.id })
    .from(docCallShares)
    .where(and(eq(docCallShares.fileId, fileId), eq(docCallShares.organizationId, viewer.organizationId), isNull(docCallShares.closedAt)))
  for (const share of shares) {
    const through = await docLevelFor(fileId, viewer, executor, { shareId: share.id })
    if (through.level) return through
  }
  return own
}

/**
 * A guest's level, for a doc token whose signature already holds: the share's level while it is open, its doc is
 * not in Trash and the guest is still in its call
 */
export async function guestDocLevel(
  claims: GuestDocClaims,
): Promise<{ file: DocRow; organizationId: string; roomName: string; level: DocLevel } | null> {
  // tenancy: a guest has no workspace, the signed share id names the one it reaches
  const [share] = await db
    .select({
      organizationId: docCallShares.organizationId,
      roomName: docCallShares.roomName,
      level: docCallShares.level,
      openedBy: docCallShares.openedBy,
    })
    .from(docCallShares)
    .where(and(eq(docCallShares.id, claims.shareId), eq(docCallShares.fileId, claims.fileId), isNull(docCallShares.closedAt)))
  if (!share) return null
  const [file] = await db
    .select()
    .from(fileAttachments)
    .where(
      and(
        eq(fileAttachments.id, claims.fileId),
        eq(fileAttachments.organizationId, share.organizationId),
        isNull(fileAttachments.deletedAt),
      ),
    )
  if (!file || !isDoc(file)) return null
  if (!(await inRoom(share.roomName, claims.identity))) return null
  const level = await openerCap(file.id, share.level as DocLevel, share.openedBy, share.organizationId, db)
  return level ? { file, organizationId: share.organizationId, roomName: share.roomName, level } : null
}

/** A paper or board in the workspace, in Trash or not, whoever asks */
export async function findDoc(fileId: string, organizationId: string): Promise<DocRow | null> {
  const [file] = await db
    .select()
    .from(fileAttachments)
    .where(and(eq(fileAttachments.id, fileId), eq(fileAttachments.organizationId, organizationId)))
  return file && isDoc(file) ? file : null
}

/** A new paper or board with an empty state, placed where `resolvePlace` allowed */
export async function createDoc(
  viewer: FileViewer,
  docType: DocType,
  place: { projectId: string | null; folderId: string | null },
  name?: string,
  via: Via | null = null,
): Promise<string> {
  const id = randomUUID()
  await db.transaction(async (tx) => {
    await tx.insert(fileAttachments).values({
      id,
      doneVia: via,
      fileName: name ?? DEFAULT_NAMES[docType],
      filePath: docPath(id),
      fileSize: EMPTY_STATE.length,
      mimeType: DOC_MIME[docType],
      docType,
      uploadedBy: viewer.userId,
      organizationId: viewer.organizationId,
      projectId: place.projectId,
      folderId: place.folderId,
    })
    await tx.insert(docContents).values({ fileId: id, organizationId: viewer.organizationId, state: EMPTY_STATE })
  })
  return id
}

/** A doc's stored state */
export async function docState(fileId: string, organizationId: string, executor: Executor = db): Promise<Buffer | null> {
  const [row] = await executor
    .select({ state: docContents.state })
    .from(docContents)
    .where(and(eq(docContents.fileId, fileId), eq(docContents.organizationId, organizationId)))
  return row?.state ?? null
}

type DocCopy = { state: Buffer; thumbnail: Buffer | null; images: { from: FileRow; id: string }[] }

/**
 * What a copy of the doc is made of: its state with its pictures pointed at new ids, its preview, and the images it
 * shows, each with the id its copy gets. Images only the original's history shows stay behind
 */
export async function docCopy(source: DocRow, organizationId: string): Promise<DocCopy | null> {
  const [row] = await db
    .select({ state: docContents.state, thumbnail: docContents.thumbnail })
    .from(docContents)
    .where(and(eq(docContents.fileId, source.id), eq(docContents.organizationId, organizationId)))
  if (!row) return null
  // The open live doc has edits its stored state does not have yet
  const open = collab().documents.get(docPath(source.id))
  const state = open ? Buffer.from(Y.encodeStateAsUpdate(open)) : row.state
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, new Uint8Array(state))
    const shown = imageIdsIn(doc).filter((id) => UUID.test(id))
    const found = shown.length
      ? await db
          .select()
          .from(fileAttachments)
          .where(
            and(
              inArray(fileAttachments.id, shown),
              eq(fileAttachments.organizationId, organizationId),
              eq(fileAttachments.kind, "docimage"),
              eq(fileAttachments.docFileId, source.id),
            ),
          )
      : []
    const images = found.map((from) => ({ from, id: randomUUID() }))
    if (images.length === 0) return { state, thumbnail: row.thumbnail, images }
    swapImages(doc, new Map(images.map((image) => [image.from.id, image.id])))
    return { state: Buffer.from(Y.encodeStateAsUpdate(doc)), thumbnail: row.thumbnail, images }
  } finally {
    doc.destroy()
  }
}

type DocPerson = { id: string; name: string; avatarUrl: string | null }

/** Who can be mentioned: a project doc's members, otherwise the owner and everyone granted it, still in the workspace */
export async function docPeople(file: DocRow, organizationId: string): Promise<DocPerson[]> {
  let ids: string[]
  if (file.projectId) {
    const rows = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(and(eq(projectMembers.projectId, file.projectId), eq(projects.organizationId, organizationId), liveProject))
    ids = rows.map((row) => row.userId)
  } else {
    const folders = file.folderId ? await folderAncestors(file.folderId, organizationId, db) : []
    const on = folders.length ? or(eq(fileGrants.fileId, file.id), inArray(fileGrants.folderId, folders)) : eq(fileGrants.fileId, file.id)
    const rows = await db
      .select({ userId: fileGrants.userId })
      .from(fileGrants)
      .where(and(on, eq(fileGrants.organizationId, organizationId)))
    ids = [file.uploadedBy, ...rows.map((row) => row.userId)]
  }
  return peopleOf(ids, organizationId)
}

/** The members in the share's call right now, for a user who reaches the doc only through it */
export async function callPeople(shareId: string, organizationId: string): Promise<DocPerson[]> {
  const [share] = await db
    .select({ roomName: docCallShares.roomName })
    .from(docCallShares)
    .where(and(eq(docCallShares.id, shareId), eq(docCallShares.organizationId, organizationId), isNull(docCallShares.closedAt)))
  const ids = share ? await participantIds(share.roomName) : []
  // Guests' identities are not ids
  return peopleOf(
    ids.filter((id) => UUID.test(id)),
    organizationId,
  )
}

/** Names and pictures of the workspace's members among `ids`, by name */
async function peopleOf(ids: string[], organizationId: string): Promise<DocPerson[]> {
  const members = await membersOf(organizationId, ids)
  const wanted = [...members]
  if (wanted.length === 0) return []
  const people = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(and(inArray(users.id, wanted), isNull(users.removedAt)))
    .orderBy(sql`lower(coalesce(${users.firstName}, '')), lower(coalesce(${users.lastName}, ''))`, users.id)
  return people.map((person) => ({ id: person.id, name: presenceName(person.firstName, person.lastName), avatarUrl: person.avatarUrl }))
}
