import { randomBytes, randomUUID } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import * as Y from "yjs"
import { db, fileAttachments } from "../db"
import type { Via } from "../utils/aiTypes"
import { docPath } from "../utils/docAccess"
import { parseDocText, type Kept, type Resolved } from "../utils/docFormat"
import { boardElements } from "../utils/boardElements"
import { checkPlan, layoutBoard, type BoardPlan } from "../utils/boardLayout"
import { applyDocWrite, boardBoxes, checkDocWrite, docTasks, revisionOf, STALE, type DocWrite, type WriteResult } from "../utils/docText"
import { BOARD_FIELD } from "../utils/docYjs"
import { logger } from "../utils/logger"
import { capCheck, type Caps } from "../utils/storageCaps"
import { collab, saveVersionNow, type DocContext } from "./collab"
import { resolveRefs } from "./docRefs"
import { docLevelFor, docState, type DocRow } from "./docs"
import { capsAndUsage, lockUsage } from "./fileQueries"
import { dropStoredObjects, type FileRow, type FileViewer } from "./files"
import { copyObject, deleteObject, objectKey } from "./storage"
import { errorText } from "../utils/errorText"

type Failed = { ok: false; error: string }

export const DOC_GONE: Failed = { ok: false, error: "not found" }
const EDITORS_ONLY: Failed = { ok: false, error: "Only people who can edit this can change it" }

/**
 * The version from before each request's first write to each file, shared by writes that run at once so only one is
 * taken. A pair whose writes all failed is forgotten, so the next write takes a fresh one
 */
type Before = { saved: Promise<void>; wrote: boolean }
const befores = new Map<string, Before>()
const BEFORES_MAX = 5000

function beforeFor(key: string, save: () => Promise<void>): Before {
  const known = befores.get(key)
  if (known) return known
  const entry: Before = { saved: save(), wrote: false }
  befores.set(key, entry)
  if (befores.size > BEFORES_MAX) befores.delete(befores.keys().next().value!)
  entry.saved.catch(() => forget(key, entry))
  return entry
}

function forget(key: string, entry: Before) {
  if (befores.get(key) === entry) befores.delete(key)
}

const contextFor = (viewer: FileViewer): DocContext => ({
  organizationId: viewer.organizationId,
  userId: viewer.userId,
  guest: null,
  level: "edit",
  shareId: null,
  sessionToken: null,
})

/** The doc as it is now: the live one when it is open, else its stored state. The caller destroys it */
export async function currentDoc(file: DocRow, organizationId: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const open = collab().documents.get(docPath(file.id))
  const state = open ? Y.encodeStateAsUpdate(open) : await docState(file.id, organizationId)
  if (state) Y.applyUpdate(doc, new Uint8Array(state))
  return doc
}

type LiveEdit = {
  doc: Y.Doc
  file: DocRow
  /** Takes the version from before the request's first write to the doc, once */
  ready(): Promise<void>
  /** Runs one change on the live doc for everyone connected, after `ready` */
  change(fn: (doc: Y.Doc) => WriteResult): Promise<WriteResult>
}

/**
 * Opens the doc for one edit as the user, who must be able to edit it right now. After a change the doc is saved
 * as a version marked with `via`, so the history shows the user's agent or AI made it
 */
export async function editDoc<T>(
  viewer: FileViewer,
  fileId: string,
  via: Via,
  requestId: string,
  edit: (live: LiveEdit) => Promise<({ ok: true } & T) | Failed>,
  fresh = false,
): Promise<({ ok: true; file: DocRow } & T) | Failed> {
  const { file, level } = await docLevelFor(fileId, viewer)
  if (!file || !level) return DOC_GONE
  if (level !== "edit") return EDITORS_ONLY
  const context = contextFor(viewer)
  const key = `${requestId}:${file.id}`
  const connection = await collab().openDirectConnection(docPath(file.id), context)
  let changed = false
  const taken: { before: Before | null } = { before: null }
  try {
    const doc = connection.document as unknown as Y.Doc
    // A doc made for this request has nothing to keep, so its first version is the one marked with `via`
    const ready = async () => {
      taken.before = fresh ? { saved: Promise.resolve(), wrote: false } : beforeFor(key, () => saveVersionNow(file.id, context, null))
      await taken.before.saved
    }
    const change = async (fn: (doc: Y.Doc) => WriteResult): Promise<WriteResult> => {
      await ready()
      let result: WriteResult = STALE
      await connection.transact((live) => {
        result = fn(live as unknown as Y.Doc)
      })
      if (result.ok) {
        changed = true
        taken.before!.wrote = true
      }
      return result
    }
    const result = await edit({ doc, file, ready, change })
    return result.ok ? { ...result, file } : result
  } finally {
    try {
      if (changed) await saveVersionNow(file.id, context, via)
    } catch (error) {
      // The write is done, so a missing version never makes it look failed and tried again
      logger.warn("Saving a version after an AI write failed", { error: errorText(error) })
    } finally {
      if (taken.before && !taken.before.wrote) forget(key, taken.before)
      await connection.disconnect()
    }
  }
}

export const USE_ADD_TO_BOARD: Failed = { ok: false, error: "Use add_to_board for boards" }
const BOARD_STALE: Failed = { ok: false, error: "The board changed, read it again" }

const NO_ROOM: Failed = {
  ok: false,
  error: "There isn't room in storage for these images. Ask the user to free some space, or leave the images out",
}
const COPY_FAILED: Failed = { ok: false, error: "An image couldn't be copied into the paper. Try again, or leave it out" }

type Copies = { ok: true; ids: Map<string, string>; undo(): Promise<void> }

/**
 * Copies image files into the paper's own images, the way an upload lands there: owned like the paper and counted
 * toward its owner or project, so everyone who can open the paper sees them
 */
async function copyImages(paper: DocRow, organizationId: string, files: FileRow[]): Promise<Copies | Failed> {
  if (files.length === 0) return { ok: true, ids: new Map(), undo: async () => {} }
  const owner: FileViewer = { userId: paper.uploadedBy, organizationId, isOrgAdmin: false }
  const projectFile = paper.projectId !== null
  const copies = files.map((from) => ({
    from,
    id: randomUUID(),
    key: objectKey("attachment", organizationId, owner.userId, from.fileName),
  }))
  const fits = (usage: { person: number; workspace: number }, caps: Caps) => {
    let used = usage
    for (const { from } of copies) {
      if (!capCheck(from.fileSize, used, caps, projectFile).ok) return false
      used = { person: used.person + from.fileSize, workspace: used.workspace + from.fileSize }
    }
    return true
  }
  const { caps, usage } = await capsAndUsage(owner)
  if (!fits(usage, caps)) return NO_ROOM
  const copied: string[] = []
  const dropObjects = () =>
    Promise.all(copied.map((key) => deleteObject(key).catch(() => dropStoredObjects(db, [key])))).catch((error) =>
      logger.warn("Removing copied images failed", { keys: copied, error: errorText(error) }),
    )
  try {
    for (const { from, key } of copies) {
      await copyObject(from.filePath, key)
      copied.push(key)
    }
  } catch (error) {
    await dropObjects()
    logger.warn("Copying an image into a paper failed", { error: errorText(error) })
    return COPY_FAILED
  }
  let saved: boolean
  try {
    saved = await db.transaction(async (tx) => {
      await lockUsage(tx, organizationId)
      if (!fits((await capsAndUsage(owner, tx)).usage, caps)) return false
      await tx.insert(fileAttachments).values(
        copies.map(({ from, id, key }) => ({
          id,
          fileName: from.fileName,
          filePath: key,
          fileSize: from.fileSize,
          mimeType: from.mimeType,
          altText: from.altText,
          kind: "docimage",
          docFileId: paper.id,
          uploadedBy: owner.userId,
          organizationId,
          projectId: paper.projectId,
        })),
      )
      return true
    })
  } catch (error) {
    await dropObjects()
    throw error
  }
  if (!saved) {
    await dropObjects()
    return NO_ROOM
  }
  const ids = copies.map((copy) => copy.id)
  return {
    ok: true,
    ids: new Map(copies.map(({ from, id }) => [from.id, id])),
    // A write that fails after the copies leaves none of them behind
    async undo() {
      await db.transaction(async (tx) => {
        await tx.delete(fileAttachments).where(and(inArray(fileAttachments.id, ids), eq(fileAttachments.organizationId, organizationId)))
        await dropStoredObjects(tx, copied)
      })
    },
  }
}

/**
 * One write to a paper as the user through their agent or AI. Its Nerla ids are looked up as the user first, and
 * what doesn't resolve stays as the text written, listed in `kept`. A `fresh` paper was just made for the request
 */
export async function writeDoc(
  viewer: FileViewer,
  fileId: string,
  given: DocWrite,
  via: Via,
  requestId: string,
  fresh = false,
): Promise<({ ok: true; file: DocRow } & { revision: string; kept: Kept[] }) | Failed> {
  return editDoc<{ revision: string; kept: Kept[] }>(
    viewer,
    fileId,
    via,
    requestId,
    async ({ doc, file, change }) => {
      if (file.docType === "board") return USE_ADD_TO_BOARD
      const write = fresh ? { ...given, revision: revisionOf(doc) } : given
      // Checked before the version from before the write is taken, so a refused write leaves none
      const checked = checkDocWrite(doc, write)
      if (!checked.ok) return checked
      const { resolved, copy } = await resolveRefs(viewer, file, parseDocText(write.text).refs, docTasks(doc))
      const copies = await copyImages(file, viewer.organizationId, copy)
      if (!copies.ok) return copies
      const refs: Resolved = {
        ...resolved,
        images: new Map([...resolved.images].map(([id, inPaper]) => [id, copies.ids.get(id) ?? inPaper])),
      }
      let kept: Kept[] = []
      const undo = () =>
        copies.undo().catch((error) => logger.warn("Removing copied images after a failed write failed", { error: String(error) }))
      let result: WriteResult
      try {
        result = await change((live) => {
          const applied = applyDocWrite(live, write, refs)
          if (applied.ok) kept = applied.kept
          return applied
        })
      } catch (error) {
        await undo()
        throw error
      }
      if (!result.ok) {
        await undo()
        return result
      }
      return { ok: true, revision: revisionOf(doc), kept }
    },
    fresh,
  )
}

const elementIds = { newId: () => randomBytes(15).toString("base64url") }

/**
 * A plan laid out beside everything already on the board and added in one change. Nothing there moves or changes.
 * A null revision is for a board just made for the request
 */
export async function writeBoard(
  viewer: FileViewer,
  fileId: string,
  plan: BoardPlan,
  revision: string | null,
  via: Via,
  requestId: string,
): Promise<({ ok: true; file: DocRow } & { revision: string }) | Failed> {
  const refused = checkPlan(plan)
  if (refused) return { ok: false, error: refused }
  return editDoc<{ revision: string }>(
    viewer,
    fileId,
    via,
    requestId,
    async ({ doc, file, change }) => {
      if (file.docType !== "board") return { ok: false, error: "That is a paper. Use write_doc for papers" }
      if (revision !== null && revisionOf(doc) !== revision) return BOARD_STALE
      const result = await change((live) => {
        if (revision !== null && revisionOf(live) !== revision) return BOARD_STALE
        const board = live.getMap<unknown>(BOARD_FIELD)
        for (const element of boardElements(plan, layoutBoard(plan, boardBoxes(board)), elementIds))
          board.set(element.id as string, element)
        return { ok: true }
      })
      return result.ok ? { ok: true, revision: revisionOf(doc) } : result
    },
    revision === null,
  )
}
