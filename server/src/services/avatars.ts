import type { FastifyReply } from "fastify"
import { sql } from "drizzle-orm"
import { getObject } from "./storage"
import { StorageMissing } from "./storage/driver"
import { purgeFile } from "./files"
import { isSafeInlineImageType } from "../utils/mimeValidation"

type StoredAvatar = { filePath: string; mimeType: string | null; fileSize: number | null }

/** Streams a stored avatar image */
export async function sendAvatar(reply: FastifyReply, attachment: StoredAvatar) {
  const body = await getObject(attachment.filePath).catch((error: unknown) => {
    if (error instanceof StorageMissing) return null
    throw error
  })
  if (!body) return reply.code(404).send({ error: "File not found in storage" })

  // Only known raster images are served inline. Anything else (including a smuggled SVG) is forced to download
  // as an opaque blob so the browser never renders it and executes embedded script.
  const inlineSafe = isSafeInlineImageType(attachment.mimeType)
  reply.header("Content-Type", inlineSafe ? (attachment.mimeType as string) : "application/octet-stream")
  reply.header("X-Content-Type-Options", "nosniff")
  if (!inlineSafe) reply.header("Content-Disposition", "attachment")
  reply.header("Cache-Control", "private, max-age=31536000")
  if (attachment.fileSize) reply.header("Content-Length", attachment.fileSize.toString())
  return reply.send(body)
}

/** Where a group's picture is served, to the group's members only. A project chat shows its project's symbol */
export const groupPictureUrl = (chat: { id: string; avatarFileId: string | null; projectId: string | null }) =>
  chat.avatarFileId && !chat.projectId ? `/group-chats/${chat.id}/avatar/${chat.avatarFileId}` : null

/** Removes group pictures nobody holds any more: no group, user or AI shows them and they were never posted */
export async function purgeGroupPictures(fileIds: (string | null | undefined)[], organizationId: string): Promise<void> {
  for (const fileId of new Set(fileIds.filter((id): id is string => !!id))) {
    await purgeFile(fileId, {
      expect: "any",
      organizationId,
      condition: sql`f.kind = 'avatar'
        and not exists (select 1 from group_chats g where g.avatar_file_id = f.id)
        and not exists (select 1 from users au where au.avatar_file_id = f.id)
        and not exists (select 1 from ai_settings s where s.avatar_file_id = f.id)
        and not exists (select 1 from file_links l where l.file_id = f.id)`,
    })
  }
}
