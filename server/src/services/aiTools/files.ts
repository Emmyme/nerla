import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { db, fileAttachments } from "../../db"
import type { FileDto } from "../fileQueries"
import { call, LIST_LIMIT, nameOf, query, tool, uuid, type ToolContext } from "./shared"

/** A project file can be renamed by any member of its project, and a copy keeps its original's name, so who named those is unknown */
const fileAuthors = (file: { ownerId: string | null; projectId: string | null; nameCopied: boolean }): (string | null)[] => [
  file.ownerId,
  ...(file.projectId || file.nameCopied ? [null] : []),
]

async function copiedNames(ctx: ToolContext, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db
    .select({ id: fileAttachments.id })
    .from(fileAttachments)
    .where(
      and(inArray(fileAttachments.id, ids), eq(fileAttachments.organizationId, ctx.organizationId), eq(fileAttachments.nameCopied, true)),
    )
  return new Set(rows.map((row) => row.id))
}

type FileInfo = {
  id: string
  fileName: string
  fileSize: number
  mimeType: string | null
  createdAt: string
  uploader: { id: string; first_name: string | null; last_name: string | null } | null
}

const TYPES = ["image", "document", "pdf", "video", "audio", "paper", "board", "other"] as const

const searchFiles = tool({
  name: "search_files",
  area: "files",
  write: false,
  description: "Find files, papers and boards the user can open, by name.",
  input: z.object({
    query: z.string().trim().min(1).max(100),
    type: z.enum(TYPES).optional(),
  }),
  async run(ctx, args) {
    const found = await call<{ files: FileDto[] }>(ctx, {
      method: "GET",
      url: `/api/files/search?${query({ q: args.query, type: args.type })}`,
    })
    const files = found.files.slice(0, LIST_LIMIT)
    const items = files.map((file) => ({
      ref: { kind: file.docType ? ("doc" as const) : ("file" as const), id: file.id },
      id: file.id,
      name: file.name,
      kind: file.docType ?? file.kind,
      size: file.size,
      owner: file.owner.name,
      project_id: file.projectId,
      updated_at: file.updatedAt,
    }))
    return {
      ok: true,
      data: null,
      items,
      authors: await copiedNames(
        ctx,
        files.map((file) => file.id),
      ).then((copied) =>
        files.flatMap((file) => fileAuthors({ ownerId: file.owner.id, projectId: file.projectId, nameCopied: copied.has(file.id) })),
      ),
    }
  },
})

const readFileInfo = tool({
  name: "read_file_info",
  area: "files",
  write: false,
  description: "Read a file's name, size, type, uploader and date. Never its contents.",
  input: z.object({ fileId: uuid }),
  async run(ctx, args) {
    const file = await call<FileInfo>(ctx, { method: "GET", url: `/api/files/${args.fileId}` })
    const [place] = await db
      .select({ projectId: fileAttachments.projectId, nameCopied: fileAttachments.nameCopied })
      .from(fileAttachments)
      .where(and(eq(fileAttachments.id, file.id), eq(fileAttachments.organizationId, ctx.organizationId)))
    const ref = { kind: "file" as const, id: file.id }
    const item = {
      ref,
      id: file.id,
      name: file.fileName,
      size: file.fileSize,
      mime_type: file.mimeType,
      created_at: file.createdAt,
      uploader: nameOf(file.uploader),
    }
    return {
      ok: true,
      data: null,
      items: [item],
      authors: fileAuthors({
        ownerId: file.uploader?.id ?? null,
        projectId: place?.projectId ?? null,
        nameCopied: place?.nameCopied ?? true,
      }),
      target: ref,
    }
  },
})

export const FILE_TOOLS = [searchFiles, readFileInfo]
