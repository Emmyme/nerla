import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { authMiddleware } from "../middleware/auth"
import { isMemberOf, membersOf, orgMiddleware, orgOf } from "../services/tenancy"
import { db, fileAttachments, groupChats, groupChatMembers, groupChatReads, messages, messageReactions, projects, users } from "../db"
import { eq, and, inArray, ne, or, isNull, gt, max, count } from "drizzle-orm"
import { liveProject } from "../utils/trash"
import { emitToChat, sendToUser } from "../services/websocket"
import {
  chatMessages,
  chatsChanged,
  dropCallAccess,
  groupAccess,
  groupMemberIds,
  inTrashedProjectChat,
  insertMessageOnce,
  keepAnAdmin,
  loadMessageDto,
  markGroupRead,
  messagePage,
  messageWindow,
  replyInChat,
  savePin,
} from "../services/chats"
import { recheckDocConnections } from "../services/collab"
import { linkFiles } from "../services/files"
import { groupPictureUrl, purgeGroupPictures, sendAvatar } from "../services/avatars"
import { mayServePicture, styleRefusal } from "../utils/groupPicture"
import { isSafeInlineImageType } from "../utils/mimeValidation"
import { markChatRead, notify } from "../services/notifications"
import { mentionsAi, parseMentions } from "../utils/mentions"
import { mentionAi } from "../services/aiMention"
import { viaOf } from "../utils/via"
import { logger } from "../utils/logger"
import { parseBody, parseParams, parseQuery } from "../validation/helpers"
import {
  chatHistoryQuerySchema,
  groupChatMessageParamsSchema,
  groupChatAvatarParamsSchema,
  groupChatCreateBodySchema,
  groupChatMemberPostBodySchema,
  groupChatIdParamsSchema,
  groupChatMemberParamsSchema,
  groupChatMessagePostBodySchema,
  groupChatUpdateBodySchema,
  messagePinBodySchema,
  reactionBodySchema,
} from "../validation/schemas"

const PROJECT_CHAT_MEMBERS = "Members of a project chat follow the project"

const MEMBERS_WITH = {
  members: { with: { user: { columns: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true } } } },
} as const

const findGroupChat = (id: string) => db.query.groupChats.findFirst({ where: eq(groupChats.id, id), with: MEMBERS_WITH })

type GroupChatRow = NonNullable<Awaited<ReturnType<typeof findGroupChat>>>

function groupChatDto(chat: GroupChatRow, members = chat.members) {
  return {
    id: chat.id,
    name: chat.name,
    description: chat.description,
    avatar_url: groupPictureUrl(chat),
    icon: chat.icon,
    color: chat.color,
    organization_id: chat.organizationId,
    project_id: chat.projectId,
    created_by: chat.createdBy,
    created_at: chat.createdAt,
    updated_at: chat.updatedAt,
    members: members.map((m) => ({
      id: m.id,
      user_id: m.userId,
      role: m.role,
      joined_at: m.joinedAt,
      user: m.user
        ? {
            id: m.user.id,
            email: m.user.email,
            first_name: m.user.firstName,
            last_name: m.user.lastName,
            avatar_url: m.user.avatarUrl,
          }
        : null,
    })),
  }
}

/** Messages from others after the user's read point, for every chat they are in, in one query */
async function unreadCounts(organizationId: string, userId: string, chatIds: string[]): Promise<Map<string, number>> {
  if (chatIds.length === 0) return new Map()
  const reads = db
    .select({ chatId: groupChatReads.groupChatId, at: max(groupChatReads.lastReadAt).as("at") })
    .from(groupChatReads)
    .where(eq(groupChatReads.userId, userId))
    .groupBy(groupChatReads.groupChatId)
    .as("reads")
  const rows = await db
    .select({ chatId: messages.threadId, n: count() })
    .from(messages)
    .leftJoin(reads, eq(reads.chatId, messages.threadId))
    .where(
      and(
        eq(messages.threadType, "group"),
        inArray(messages.threadId, chatIds),
        eq(messages.organizationId, organizationId),
        ne(messages.senderId, userId),
        or(isNull(reads.at), gt(messages.createdAt, reads.at)),
      ),
    )
    .groupBy(messages.threadId)
  return new Map(rows.map((row) => [row.chatId as string, Number(row.n)]))
}

async function groupChatRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user

    try {
      const member = orgOf(request)

      const memberships = await db.query.groupChatMembers.findMany({
        where: eq(groupChatMembers.userId, user.id),
        with: {
          groupChat: { with: MEMBERS_WITH },
        },
      })

      const projectIds = [...new Set(memberships.flatMap((membership) => membership.groupChat.projectId ?? []))]
      const liveProjects = projectIds.length
        ? await db
            .select({ id: projects.id })
            .from(projects)
            .where(and(inArray(projects.id, projectIds), eq(projects.organizationId, member.organizationId), liveProject))
        : []
      const live = new Set(liveProjects.map((project) => project.id))
      // A membership kept from another organization never shows, nor the chat of a project in Trash
      const userGroupChats = memberships.filter(
        (membership) =>
          membership.groupChat.organizationId === member.organizationId &&
          (!membership.groupChat.projectId || live.has(membership.groupChat.projectId)),
      )
      const unread = await unreadCounts(member.organizationId, user.id, [
        ...new Set(userGroupChats.map((membership) => membership.groupChat.id)),
      ])
      const current = await membersOf(member.organizationId, [
        ...new Set(userGroupChats.flatMap((membership) => membership.groupChat.members.map((m) => m.userId))),
      ])
      const formattedGroupChats = userGroupChats.map((membership) => {
        const members = membership.groupChat.members.filter((m) => current.has(m.userId))
        return {
          ...groupChatDto(membership.groupChat, members),
          member_count: members.length,
          unread_count: unread.get(membership.groupChat.id) ?? 0,
        }
      })

      return reply.send(formattedGroupChats)
    } catch (error) {
      logger.error("Error fetching group chats:", error)
      return reply.code(500).send({ error: "Failed to fetch group chats" })
    }
  })

  fastify.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(groupChatIdParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params

    try {
      const membership = await groupAccess(orgOf(request).organizationId, user.id, id)

      if (!membership) {
        return notMember(request, reply, id)
      }

      const groupChat = await findGroupChat(id)

      if (!groupChat) {
        return reply.code(404).send({ error: "Group chat not found" })
      }
      const current = await membersOf(
        groupChat.organizationId,
        groupChat.members.map((m) => m.userId),
      )

      const formattedGroupChat = groupChatDto(
        groupChat,
        groupChat.members.filter((m) => current.has(m.userId)),
      )

      return reply.send(formattedGroupChat)
    } catch (error) {
      logger.error("Error fetching group chat:", error)
      return reply.code(500).send({ error: "Failed to fetch group chat" })
    }
  })

  fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const body = parseBody(groupChatCreateBodySchema, request.body, reply)
    if (!body) return

    try {
      const member = orgOf(request)

      const allMemberIds = [...new Set([user.id, ...body.member_ids])]
      const orgMembers = await membersOf(member.organizationId, allMemberIds)
      if (orgMembers.size !== allMemberIds.length) {
        return reply.code(400).send({ error: "All members must be in the same organization" })
      }

      const now = new Date().toISOString()
      const [groupChat] = await db
        .insert(groupChats)
        .values({
          name: body.name.trim(),
          description: body.description?.trim() || null,
          icon: body.icon ?? null,
          color: body.color ?? null,
          organizationId: member.organizationId,
          createdBy: user.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning()

      await db.insert(groupChatMembers).values(
        allMemberIds.map((memberId) => ({
          groupChatId: groupChat.id,
          userId: memberId,
          role: memberId === user.id ? "admin" : "member",
          joinedAt: now,
        })),
      )
      chatsChanged(member.organizationId, allMemberIds)

      const completeGroupChat = await findGroupChat(groupChat.id)

      return reply.code(201).send(groupChatDto(completeGroupChat!))
    } catch (error) {
      logger.error("Error creating group chat:", error)
      return reply.code(500).send({ error: "Failed to create group chat" })
    }
  })

  // A group's picture, for group members only. Anything else looks like a random id
  fastify.get("/:id/avatar/:fileId", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseParams(groupChatAvatarParamsSchema, request.params, reply)
    if (!params) return
    try {
      const { organizationId } = orgOf(request)
      const notFound = () => reply.code(404).send({ error: "File not found" })
      const membership = await groupAccess(organizationId, request.user.id, params.id)
      const group = membership
        ? await db.query.groupChats.findFirst({
            where: and(eq(groupChats.id, params.id), eq(groupChats.organizationId, organizationId)),
            columns: { avatarFileId: true },
          })
        : undefined
      if (!mayServePicture(membership, group?.avatarFileId, params.fileId)) return notFound()
      const attachment = await db.query.fileAttachments.findFirst({
        where: and(eq(fileAttachments.id, params.fileId), eq(fileAttachments.organizationId, organizationId)),
      })
      if (!attachment) return notFound()
      return await sendAvatar(reply, attachment)
    } catch (error) {
      logger.error("Error serving a group picture", error)
      return reply.code(500).send({ error: "Failed to serve the picture" })
    }
  })

  fastify.patch("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(groupChatIdParamsSchema, request.params, reply)
    if (!params) return
    const body = parseBody(groupChatUpdateBodySchema, request.body, reply)
    if (!body) return

    try {
      const { organizationId } = orgOf(request)
      const membership = await groupAccess(organizationId, user.id, params.id)
      const refusal = styleRefusal(membership)
      if (refusal) return reply.code(refusal.status).send({ error: refusal.error })

      // A picture replaces the symbol, and a symbol takes the picture away
      let picture: { avatarFileId: string | null } | null = null
      if (body.avatar_file_id) {
        const file = await db.query.fileAttachments.findFirst({
          where: and(
            eq(fileAttachments.id, body.avatar_file_id),
            eq(fileAttachments.organizationId, organizationId),
            eq(fileAttachments.uploadedBy, user.id),
            eq(fileAttachments.kind, "avatar"),
          ),
          columns: { id: true, mimeType: true },
        })
        if (!file) return reply.code(404).send({ error: "Picture not found" })
        if (!isSafeInlineImageType(file.mimeType)) {
          return reply.code(400).send({ error: "The picture must be a JPEG, PNG, GIF, WebP, AVIF, or BMP image" })
        }
        picture = { avatarFileId: file.id }
      } else if (body.avatar_file_id === null || body.icon) {
        picture = { avatarFileId: null }
      }

      // The row stays locked from reading the old picture to writing the new one, so two changes never both keep it
      const changed = await db.transaction(async (tx) => {
        const [before] = await tx
          .select({ avatarFileId: groupChats.avatarFileId })
          .from(groupChats)
          .where(and(eq(groupChats.id, params.id), eq(groupChats.organizationId, organizationId)))
          .for("update")
        if (!before) return null
        const [after] = await tx
          .update(groupChats)
          .set({
            ...(body.icon !== undefined && { icon: body.icon }),
            ...(body.color !== undefined && { color: body.color }),
            ...picture,
            ...(picture?.avatarFileId && { icon: null, color: null }),
          })
          .where(and(eq(groupChats.id, params.id), eq(groupChats.organizationId, organizationId)))
          .returning({
            id: groupChats.id,
            icon: groupChats.icon,
            color: groupChats.color,
            avatarFileId: groupChats.avatarFileId,
            projectId: groupChats.projectId,
          })
        return { before: before.avatarFileId, updated: after }
      })
      if (!changed?.updated) return reply.code(404).send({ error: "Group chat not found" })
      const { before, updated } = changed

      if (before && before !== updated.avatarFileId) {
        await purgeGroupPictures([before], organizationId).catch((error) =>
          logger.error("Error removing the group's previous picture", error),
        )
      }
      chatsChanged(organizationId, await groupMemberIds(params.id))
      return reply.send({ id: updated.id, icon: updated.icon, color: updated.color, avatar_url: groupPictureUrl(updated) })
    } catch (error) {
      logger.error("Error updating group chat:", error)
      return reply.code(500).send({ error: "Failed to update group chat" })
    }
  })

  fastify.post("/:id/members", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(groupChatIdParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params
    const body = parseBody(groupChatMemberPostBodySchema, request.body, reply)
    if (!body) return

    try {
      const groupChat = await db.query.groupChats.findFirst({
        where: and(eq(groupChats.id, id), eq(groupChats.organizationId, orgOf(request).organizationId)),
      })

      if (!groupChat) {
        return reply.code(404).send({ error: "Group chat not found" })
      }

      const userMembership = await groupAccess(orgOf(request).organizationId, user.id, id)

      if (!userMembership) {
        return notMember(request, reply, id)
      }

      if (groupChat.projectId) {
        return reply.code(409).send({ error: PROJECT_CHAT_MEMBERS })
      }

      if (userMembership.role !== "admin" && groupChat.createdBy !== user.id) {
        return reply.code(403).send({ error: "Only admins or the group creator can add members" })
      }

      if (!(await isMemberOf(body.user_id, orgOf(request).organizationId))) {
        return reply.code(400).send({ error: "User is not in the organization" })
      }

      const existingMembership = await db.query.groupChatMembers.findFirst({
        where: and(eq(groupChatMembers.groupChatId, id), eq(groupChatMembers.userId, body.user_id)),
      })

      if (existingMembership) {
        return reply.code(400).send({ error: "User is already a member" })
      }

      await db.insert(groupChatMembers).values({
        groupChatId: id,
        userId: body.user_id,
        role: "member",
        joinedAt: new Date().toISOString(),
      })
      chatsChanged(orgOf(request).organizationId, await groupMemberIds(id))

      return reply.send({ message: "Member added successfully" })
    } catch (error) {
      logger.error("Error adding member:", error)
      return reply.code(500).send({ error: "Failed to add member" })
    }
  })

  fastify.delete("/:id/members/:userId", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(groupChatMemberParamsSchema, request.params, reply)
    if (!params) return
    const { id, userId } = params

    try {
      const groupChat = await db.query.groupChats.findFirst({
        where: and(eq(groupChats.id, id), eq(groupChats.organizationId, orgOf(request).organizationId)),
      })

      if (!groupChat) {
        return reply.code(404).send({ error: "Group chat not found" })
      }

      const userMembership = await groupAccess(orgOf(request).organizationId, user.id, id)

      if (!userMembership) {
        return notMember(request, reply, id)
      }

      if (groupChat.projectId) {
        return reply.code(409).send({ error: PROJECT_CHAT_MEMBERS })
      }

      // Admins, the creator, or a user removing themselves are all allowed
      if (userMembership.role !== "admin" && groupChat.createdBy !== user.id && user.id !== userId) {
        return reply.code(403).send({ error: "Only admins or the group creator can remove other members" })
      }

      const removed = await db.transaction(async (tx) => {
        // Serializes removals so two admins leaving at once still leave one behind
        await tx.select({ id: groupChats.id }).from(groupChats).where(eq(groupChats.id, id)).for("update")
        await dropCallAccess([userId], [id], tx)
        const rows = await tx
          .delete(groupChatMembers)
          .where(and(eq(groupChatMembers.groupChatId, id), eq(groupChatMembers.userId, userId)))
          .returning({ userId: groupChatMembers.userId })
        await keepAnAdmin(id, tx)
        return rows.length > 0
      })
      if (removed) {
        chatsChanged(orgOf(request).organizationId, [userId, ...(await groupMemberIds(id))])
        // The chat may have been their only way to a paper or board they have open
        void recheckDocConnections({ userId })
      }

      return reply.send({ message: "Member removed successfully" })
    } catch (error) {
      logger.error("Error removing member:", error)
      return reply.code(500).send({ error: "Failed to remove member" })
    }
  })

  fastify.get("/:id/messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(groupChatIdParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params
    const query = parseQuery(chatHistoryQuerySchema, request.query, reply)
    if (!query) return

    try {
      const { organizationId } = orgOf(request)
      const membership = await groupAccess(organizationId, user.id, id)

      // A message looked for in a chat the user is not in answers like one that does not exist
      if (!membership && query.around) return reply.code(404).send({ error: "Message not found" })
      if (!membership) {
        return notMember(request, reply, id)
      }

      const chat = chatMessages(organizationId, user.id, "group", id)
      if (query.around) {
        const window = await messageWindow(chat, query.around, query.limit)
        return window ? reply.send(window) : reply.code(404).send({ error: "Message not found" })
      }
      const page = await messagePage(
        chat,
        { before: query.before, beforeId: query.beforeId, after: query.after, afterId: query.afterId },
        query.limit,
      )
      return reply.send(page)
    } catch (error) {
      logger.error("Error fetching group messages:", error)
      return reply.code(500).send({ error: "Failed to fetch messages" })
    }
  })

  fastify.put("/:id/read", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(groupChatIdParamsSchema, request.params, reply)
    if (!params) return

    try {
      const membership = await groupAccess(orgOf(request).organizationId, user.id, params.id)
      if (!membership) {
        return notMember(request, reply, params.id)
      }

      await markGroupRead(params.id, user.id)
      sendToUser(orgOf(request).organizationId, user.id, { type: "chat-read", kind: "group", id: params.id })
      await markChatRead(user.id, orgOf(request).organizationId, { kind: "group", id: params.id })
      return reply.send({ message: "Marked as read" })
    } catch (error) {
      logger.error("Error marking group chat read:", error)
      return reply.code(500).send({ error: "Failed to mark as read" })
    }
  })

  fastify.post("/:id/messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(groupChatIdParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params
    const body = parseBody(groupChatMessagePostBodySchema, request.body, reply)
    if (!body) return

    try {
      const { organizationId } = orgOf(request)
      const membership = await groupAccess(organizationId, user.id, id)

      if (!membership) {
        return notMember(request, reply, id)
      }

      const chat = chatMessages(organizationId, user.id, "group", id)
      if (!(await replyInChat(chat, body.replyToId))) {
        return reply.code(400).send({ error: "You can only reply to a message in this chat" })
      }

      const now = new Date().toISOString()
      const message = await insertMessageOnce(chat, {
        senderId: user.id,
        threadType: "group",
        threadId: id,
        organizationId,
        content: body.content?.trim() || "(file attachment)",
        isRead: false,
        isEdited: false,
        createdAt: now,
        replyToId: body.replyToId || null,
        clientId: body.clientId ?? null,
        doneVia: viaOf(request),
      })
      if (!message.created) {
        const dto = await loadMessageDto(message.id)
        return reply.code(201).send({ ...dto!, client_id: body.clientId })
      }

      if (body.fileIds?.length) {
        const fileIds = body.fileIds
        await db.transaction((tx) =>
          linkFiles({ messageId: message.id }, fileIds, { userId: user.id, organizationId }, membership.chat.projectId, tx),
        )
      }
      await db.update(groupChats).set({ updatedAt: now }).where(eq(groupChats.id, id))

      const dto = await loadMessageDto(message.id)
      const formattedMessage = { ...dto!, client_id: body.clientId ?? null }

      try {
        emitToChat(organizationId, { kind: "group", id, memberIds: await groupMemberIds(id) }, "new-group-message", {
          message: formattedMessage,
        })
      } catch (err) {
        logger.error("Error emitting socket event:", err)
      }
      const mentions = parseMentions(body.content ?? "")
      if (mentions.length > 0) void notify(organizationId, { type: "message", actorId: user.id, messageId: message.id, mentions })
      // Never for a request made through the AI or an agent, so nothing they say asks the AI again
      if (!viaOf(request) && mentionsAi(body.content ?? "")) {
        mentionAi({
          asker: { userId: user.id, organizationId, isAdmin: orgOf(request).role === "admin" },
          place: { kind: "group", id },
          text: body.content ?? "",
          replyTo: { messageId: message.id },
          source: { kind: "message", id: message.id },
        })
      }

      return reply.code(201).send(formattedMessage)
    } catch (error) {
      logger.error("Error sending message:", error)
      return reply.code(500).send({ error: "Failed to send message" })
    }
  })
  fastify.put("/:id/messages/:messageId/pin", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(groupChatMessageParamsSchema, request.params, reply)
    if (!params) return

    try {
      const membership = await groupAccess(orgOf(request).organizationId, user.id, params.id)

      if (!membership) {
        return notMember(request, reply, params.id)
      }

      if (membership.role !== "admin") {
        const groupChat = await db.query.groupChats.findFirst({
          where: eq(groupChats.id, params.id),
          columns: { createdBy: true },
        })
        if (!groupChat || groupChat.createdBy !== user.id) {
          return reply.code(403).send({ error: "Only admins or the group creator can pin messages" })
        }
      }

      const message = await db.query.messages.findFirst({
        where: and(
          eq(messages.id, params.messageId),
          eq(messages.threadType, "group"),
          eq(messages.threadId, params.id),
          eq(messages.organizationId, orgOf(request).organizationId),
        ),
      })

      if (!message) {
        return reply.code(404).send({ error: "Message not found" })
      }

      const body = parseBody(messagePinBodySchema, request.body, reply)
      if (!body) return

      if (message.kind === "call") {
        return reply.code(400).send({ error: "A call message cannot be pinned" })
      }

      const { changed, ...pin } = await savePin(message, body.pinned)
      if (changed) {
        emitToChat(
          orgOf(request).organizationId,
          { kind: "group", id: params.id, memberIds: await groupMemberIds(params.id) },
          "message-pinned",
          { messageId: pin.id, is_pinned: pin.is_pinned, pinned_at: pin.pinned_at },
        )
      }

      return reply.send(pin)
    } catch (error) {
      logger.error("Error pinning group message:", error)
      return reply.code(500).send({ error: "Failed to pin message" })
    }
  })
  fastify.post("/:id/messages/:messageId/reactions", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(groupChatMessageParamsSchema, request.params, reply)
    if (!params) return
    const body = parseBody(reactionBodySchema, request.body, reply)
    if (!body) return

    try {
      const membership = await groupAccess(orgOf(request).organizationId, user.id, params.id)

      if (!membership) {
        return notMember(request, reply, params.id)
      }

      const message = await db.query.messages.findFirst({
        where: and(
          eq(messages.id, params.messageId),
          eq(messages.threadType, "group"),
          eq(messages.threadId, params.id),
          eq(messages.organizationId, orgOf(request).organizationId),
        ),
      })

      if (!message) {
        return reply.code(404).send({ error: "Message not found" })
      }

      const existing = await db.query.messageReactions.findFirst({
        where: and(
          eq(messageReactions.messageId, params.messageId),
          eq(messageReactions.userId, user.id),
          eq(messageReactions.emoji, body.emoji),
          eq(messageReactions.organizationId, orgOf(request).organizationId),
        ),
      })

      if (existing) {
        await db.delete(messageReactions).where(eq(messageReactions.id, existing.id))

        emitToChat(
          orgOf(request).organizationId,
          { kind: "group", id: params.id, memberIds: await groupMemberIds(params.id) },
          "reaction-removed",
          { messageId: params.messageId, emoji: body.emoji, userId: user.id, groupChatId: params.id },
        )

        return reply.send({ action: "removed", emoji: body.emoji, messageId: params.messageId })
      } else {
        const [reaction] = await db
          .insert(messageReactions)
          .values({
            messageId: params.messageId,
            userId: user.id,
            organizationId: orgOf(request).organizationId,
            emoji: body.emoji,
          })
          .returning()

        const reactingUser = await db.query.users.findFirst({
          where: eq(users.id, user.id),
          columns: { id: true, firstName: true, lastName: true },
        })

        const reactionData = {
          messageId: params.messageId,
          groupChatId: params.id,
          reaction: {
            id: reaction.id,
            emoji: reaction.emoji,
            user_id: reaction.userId,
            user: reactingUser
              ? {
                  id: reactingUser.id,
                  first_name: reactingUser.firstName,
                  last_name: reactingUser.lastName,
                }
              : null,
          },
        }

        emitToChat(
          orgOf(request).organizationId,
          { kind: "group", id: params.id, memberIds: await groupMemberIds(params.id) },
          "reaction-added",
          reactionData,
        )

        return reply.code(201).send({
          action: "added",
          reaction: reactionData.reaction,
          messageId: params.messageId,
        })
      }
    } catch (error) {
      logger.error("Error toggling group reaction:", error)
      return reply.code(500).send({ error: "Failed to toggle reaction" })
    }
  })
}

/** A user outside the chat gets 403, but a member of a project chat whose project is in Trash gets 404 like the project */
async function notMember(request: FastifyRequest, reply: FastifyReply, groupChatId: string) {
  const userId = request.user.id
  if (await inTrashedProjectChat(orgOf(request).organizationId, userId, groupChatId)) {
    return reply.code(404).send({ error: "Group chat not found" })
  }
  return reply.code(403).send({ error: "Not a member of this group chat" })
}

export default groupChatRoutes
