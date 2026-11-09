import { and, eq, inArray } from "drizzle-orm"
import type * as Y from "yjs"
import { db, tasks } from "../db"
import { NO_REFS, type Ref, type Resolved } from "../utils/docFormat"
import { UUID } from "../utils/uuid"
import { docBlocks, docTasks } from "../utils/docText"
import { can } from "../utils/fileAccess"
import { isSafeInlineImageType } from "../utils/mimeValidation"
import { taskAccessLevel } from "../utils/taskAccess"
import { liveTask } from "../utils/trash"
import { docLevelFor, docPeople, type DocRow } from "./docs"
import { loadFileFacts, type FileRow, type FileViewer } from "./files"
import { callerMembership, projectReadAccess } from "./projectAccess"

type ResolvedRefs = {
  resolved: Resolved
  /** Image files from the asker's own files, to copy into the paper before the write */
  copy: FileRow[]
}

/** Where a file opens in Nerla: a paper or board on its own page, any other file in the folder it sits in */
function fileHref(file: FileRow, viewer: FileViewer): string {
  if (file.docType === "paper" || file.docType === "board") return `/${file.docType}/${file.id}`
  const folder = file.folderId ? `/folder/${file.folderId}` : ""
  if (file.projectId) return `/files${folder}?project=${file.projectId}`
  if (file.uploadedBy === viewer.userId) return `/files${folder}`
  return "/files/shared"
}

async function taskRef(viewer: FileViewer, id: string) {
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, id), eq(tasks.organizationId, viewer.organizationId), liveTask),
    with: { project: { with: callerMembership(viewer.userId) } },
  })
  if (!task || !taskAccessLevel(task, viewer.userId, viewer.organizationId, viewer.isOrgAdmin)) return null
  return { title: task.title, href: task.project ? `/project/${task.project.slug}?task=${task.id}` : `/?task=${task.id}` }
}

/** The task lines' ids a reader can't open, as the paper's Hidden task chip shows them. With no reader, those gone for everyone */
async function hiddenTasks(organizationId: string, ids: string[], viewer: FileViewer | null): Promise<Set<string>> {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))]
  const valid = wanted.filter((id) => UUID.test(id))
  let open: string[] = []
  if (valid.length && viewer) {
    const rows = await db.query.tasks.findMany({
      where: and(inArray(tasks.id, valid), eq(tasks.organizationId, organizationId), liveTask),
      with: { project: { with: callerMembership(viewer.userId) } },
    })
    open = rows.filter((task) => taskAccessLevel(task, viewer.userId, organizationId, viewer.isOrgAdmin)).map((task) => task.id)
  } else if (valid.length) {
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(inArray(tasks.id, valid), eq(tasks.organizationId, organizationId), liveTask))
    open = rows.map((task) => task.id)
  }
  return new Set(wanted.filter((id) => !open.includes(id)))
}

/** A paper's blocks as the reader may see them, with a task line they can't open marked hidden */
export async function paperText(doc: Y.Doc, organizationId: string, viewer: FileViewer | null): Promise<string> {
  return docBlocks(doc, await hiddenTasks(organizationId, [...docTasks(doc).keys()], viewer)).text
}

/**
 * The Nerla ids a write names, looked up as the asker by the app's own rules: users who can open the paper, tasks
 * they can read, papers, boards and files they can open, projects they can read, and images among their files
 */
export async function resolveRefs(
  viewer: FileViewer,
  paper: DocRow,
  refs: Ref[],
  inPaper: ReadonlyMap<string, { title: string }> = new Map(),
): Promise<ResolvedRefs> {
  if (refs.length === 0) return { resolved: NO_REFS, copy: [] }
  const people = new Map<string, string>()
  const tasksFound = new Map<string, { title: string }>()
  const links = new Map<string, string>()
  const images = new Map<string, string>()
  const boards = new Set<string>()
  const copy: FileRow[] = []

  if (refs.some((ref) => ref.kind === "person")) {
    const wanted = new Set(refs.filter((ref) => ref.kind === "person").map((ref) => ref.id))
    for (const person of await docPeople(paper, viewer.organizationId)) if (wanted.has(person.id)) people.set(person.id, person.name)
  }

  await Promise.all(
    refs.map(async (ref) => {
      switch (ref.kind) {
        case "task": {
          const task = await taskRef(viewer, ref.id)
          const stored = inPaper.get(ref.id)
          if (task) {
            tasksFound.set(ref.id, { title: task.title })
            links.set(`task:${ref.id}`, task.href)
          } else if (stored) {
            // A task line already in this paper keeps its task and stored title, even one the asker can't open now
            tasksFound.set(ref.id, stored)
          }
          return
        }
        case "paper":
        case "board": {
          const { file, level } = await docLevelFor(ref.id, viewer)
          if (!file || !level) return
          links.set(`${ref.kind}:${ref.id}`, `/${file.docType}/${file.id}`)
          if (file.docType === "board") boards.add(ref.id)
          return
        }
        case "project": {
          const access = await projectReadAccess(viewer.userId, viewer.organizationId, ref.id)
          if (access) links.set(`project:${ref.id}`, `/project/${access.project.slug}`)
          return
        }
        case "file": {
          const loaded = await loadFileFacts(ref.id, viewer)
          if (loaded && !loaded.file.deletedAt && can("view", loaded.facts, loaded.viewer))
            links.set(`file:${ref.id}`, fileHref(loaded.file, viewer))
          return
        }
        case "image": {
          const loaded = await loadFileFacts(ref.id, viewer)
          if (!loaded) return
          const { file } = loaded
          // An image already in this paper stays as it is, so rewriting a block never copies it again
          if (file.kind === "docimage" && file.docFileId === paper.id) images.set(ref.id, ref.id)
          else if (!file.deletedAt && !file.docType && isSafeInlineImageType(file.mimeType) && can("view", loaded.facts, loaded.viewer)) {
            images.set(ref.id, ref.id)
            copy.push(file)
          }
          return
        }
      }
    }),
  )
  return { resolved: { people, tasks: tasksFound, links, images, boards, drawn: new Set(), hrefs: new Map() }, copy }
}
