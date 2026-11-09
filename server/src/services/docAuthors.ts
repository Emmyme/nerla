import { and, eq, inArray } from "drizzle-orm"
import { db, docCallShares, docComments, docVersions, fileGrants } from "../db"
import { textAuthor } from "./aiTools/shared"
import { KEPT_VERSIONS, unsavedEditors } from "./collab"
import { EMPTY_STATE, type DocRow } from "./docs"

export type DocFacts = { id: string; ownerId: string | null; projectId: string | null; size: number }

export const docFacts = (file: DocRow): DocFacts => ({
  id: file.id,
  ownerId: file.uploadedBy,
  projectId: file.projectId,
  size: file.fileSize,
})

/**
 * Who may have written each doc's text, comments included: the owner, every version's editors, anyone who can edit
 * it now and anyone with changes no version holds yet. Unknown (null) when project members could edit it, when the AI
 * or an agent wrote in it, when it is a copy, when a call share let guests edit it, when old versions are gone, or when
 * nobody is known to have written what it holds
 */
export async function docAuthors(organizationId: string, docs: DocFacts[]): Promise<(string | null)[][]> {
  const ids = docs.map((doc) => doc.id)
  if (ids.length === 0) return []
  const [versions, comments, grants, shares] = await Promise.all([
    db
      .select({ fileId: docVersions.fileId, editorIds: docVersions.editorIds, via: docVersions.via, copied: docVersions.copied })
      .from(docVersions)
      .where(and(inArray(docVersions.fileId, ids), eq(docVersions.organizationId, organizationId))),
    db
      .select({ fileId: docComments.fileId, authorId: docComments.authorId, doneVia: docComments.doneVia })
      .from(docComments)
      .where(and(inArray(docComments.fileId, ids), eq(docComments.organizationId, organizationId))),
    db
      .select({ fileId: fileGrants.fileId, userId: fileGrants.userId })
      .from(fileGrants)
      .where(and(inArray(fileGrants.fileId, ids), eq(fileGrants.organizationId, organizationId), eq(fileGrants.level, "edit"))),
    db
      .select({ fileId: docCallShares.fileId })
      .from(docCallShares)
      .where(and(inArray(docCallShares.fileId, ids), eq(docCallShares.organizationId, organizationId), eq(docCallShares.level, "edit"))),
  ])
  return docs.map((doc) => {
    const own = versions.filter((row) => row.fileId === doc.id)
    const unsaved = unsavedEditors(doc.id)
    const unknown =
      !!doc.projectId ||
      own.some((row) => row.via || row.copied) ||
      shares.some((row) => row.fileId === doc.id) ||
      own.length >= KEPT_VERSIONS ||
      (own.length === 0 && !unsaved && doc.size > EMPTY_STATE.length)
    const authors = new Set<string | null>([
      doc.ownerId,
      ...own.flatMap((row) => row.editorIds),
      ...(unsaved ?? []),
      ...grants.filter((row) => row.fileId === doc.id).map((row) => row.userId),
      ...comments.filter((row) => row.fileId === doc.id).map((row) => textAuthor(row.authorId, row.doneVia)),
    ])
    if (unknown) authors.add(null)
    return [...authors]
  })
}
