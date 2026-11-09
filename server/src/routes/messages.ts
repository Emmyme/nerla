import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { authMiddleware } from "../middleware/auth"
import { orgMiddleware, orgOf } from "../services/tenancy"
import { db, fileLinks, messages, users, messageReactions } from "../db"
import { eq, and, or, isNull } from "drizzle-orm"
import { AI_WORDS, saidByAi } from "../utils/aiTypes"
import { emitMessageRead, emitToChat, sendToUser } from "../services/websocket"
import {
  chatForMessage,
  chatMessages,
  dmAllowed,
  insertMessageOnce,
  loadMessageDto,
  messagePage,
  messageWindow,
  replyInChat,
  savePin,
} from "../services/chats"
import { recheckDocConnections } from "../services/collab"
import { linkFiles } from "../services/files"
import { announceRemoved, dropNotifications, markChatRead, notify } from "../services/notifications"
import { addedAiMention, addedMentions, parseMentions } from "../utils/mentions"
import { mentionAi } from "../services/aiMention"
import { viaOf } from "../utils/via"
import { logger } from "../utils/logger"
import { parseBody, parseParams, parseQuery } from "../validation/helpers"
import {
  messagePostBodySchema,
  messagePutBodySchema,
  messageIdParamsSchema,
  messageAttachmentParamsSchema,
  contactConversationParamsSchema,
  messagePinBodySchema,
  reactionBodySchema,
  chatHistoryQuerySchema,
} from "../validation/schemas"

const OUTSIDE_ORG = "You can only message people in your organization"

async function messageRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authMiddleware)
  fastify.addHook("preHandler", orgMiddleware)

  fastify.get("/conversation/:contactId", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(contactConversationParamsSchema, request.params, reply)
    if (!params) return
    const query = parseQuery(chatHistoryQuerySchema, request.query, reply)
    if (!query) return

    try {
      const { organizationId } = orgOf(request)
      const allowed = await dmAllowed(organizationId, user.id, params.contactId)
      // A message looked for in a chat the user is not in answers like one that does not exist
      if (!allowed && query.around) return reply.code(404).send({ error: "Message not found" })
      if (!allowed) return reply.code(403).send({ error: OUTSIDE_ORG })
      const chat = chatMessages(organizationId, user.id, "dm", params.contactId)
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
      logger.error("Error fetching messages:", error)
      return reply.code(500).send({ error: "Failed to fetch messages" })
    }
  })

  fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const body = parseBody(messagePostBodySchema, request.body, reply)
    if (!body) return

    try {
      const { organizationId } = orgOf(request)
      // A recipient outside the workspace answers like an unknown id
      if (!(await dmAllowed(organizationId, user.id, body.recipientId))) {
        return reply.code(404).send({ error: "Recipient not found" })
      }
      const chat = chatMessages(organizationId, user.id, "dm", body.recipientId)
      if (!(await replyInChat(chat, body.replyToId))) {
        return reply.code(400).send({ error: "You can only reply to a message in this chat" })
      }

      const message = await insertMessageOnce(chat, {
        senderId: user.id,
        recipientId: body.recipientId,
        organizationId,
        content: body.content,
        isRead: false,
        replyToId: body.replyToId || null,
        doneVia: viaOf(request),
        clientId: body.clientId ?? null,
      })
      if (!message.created) {
        const dto = await loadMessageDto(message.id)
        return reply.code(201).send({ ...dto!, client_id: body.clientId })
      }

      if (body.fileIds?.length) {
        const fileIds = body.fileIds
        await db.transaction((tx) => linkFiles({ messageId: message.id }, fileIds, { userId: user.id, organizationId }, null, tx))
      }

      const dto = await loadMessageDto(message.id)
      const formattedMessage = { ...dto!, client_id: body.clientId ?? null }

      try {
        emitToChat(organizationId, { kind: "dm", a: user.id, b: body.recipientId }, "new-message", { message: formattedMessage })
      } catch (err) {
        logger.error("Error emitting socket event:", err)
      }
      const mentions = parseMentions(body.content)
      if (mentions.length > 0) void notify(organizationId, { type: "message", actorId: user.id, messageId: message.id, mentions })

      return reply.code(201).send(formattedMessage)
    } catch (error) {
      logger.error("Error sending message:", error)
      return reply.code(500).send({ error: "Failed to send message" })
    }
  })

  fastify.put("/read/:contactId", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(contactConversationParamsSchema, request.params, reply)
    if (!params) return
    const { contactId } = params

    try {
      const { organizationId } = orgOf(request)
      if (!(await dmAllowed(organizationId, user.id, contactId))) {
        return reply.code(403).send({ error: OUTSIDE_ORG })
      }
      const updatedMessages = await db
        .update(messages)
        .set({ isRead: true })
        .where(
          and(
            eq(messages.senderId, contactId),
            eq(messages.recipientId, user.id),
            isNull(messages.threadType),
            eq(messages.organizationId, organizationId),
            eq(messages.isRead, false),
          ),
        )
        .returning({ id: messages.id })

      try {
        updatedMessages.forEach((msg) => {
          emitMessageRead(organizationId, contactId, msg.id)
        })
        sendToUser(organizationId, user.id, { type: "chat-read", kind: "dm", id: contactId })
      } catch (err) {
        logger.error("Error emitting socket event:", err)
      }
      await markChatRead(user.id, organizationId, { kind: "dm", id: contactId })

      return reply.send({ message: "Messages marked as read" })
    } catch (error) {
      logger.error("Error marking messages as read:", error)
      return reply.code(500).send({ error: "Failed to mark messages as read" })
    }
  })

  fastify.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(messageIdParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params

    try {
      const { organizationId } = orgOf(request)
      const message = await db.query.messages.findFirst({
        where: and(
          eq(messages.id, id),
          or(eq(messages.senderId, user.id), eq(messages.recipientId, user.id)),
          eq(messages.organizationId, organizationId),
        ),
      })

      if (!message || !(await chatForMessage(organizationId, user.id, message))) {
        return reply.code(404).send({ error: "Message not found" })
      }

      return reply.send(message)
    } catch (error) {
      logger.error("Error fetching message:", error)
      return reply.code(500).send({ error: "Failed to fetch message" })
    }
  })

  fastify.put("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(messageIdParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params
    const body = parseBody(messagePutBodySchema, request.body, reply)
    if (!body) return

    try {
      const { organizationId, role } = orgOf(request)
      const message = await db.query.messages.findFirst({
        where: and(eq(messages.id, id), eq(messages.senderId, user.id), eq(messages.organizationId, organizationId)),
      })

      if (!message) {
        return reply.code(404).send({ error: "Message not found or unauthorized" })
      }
      const chat = await chatForMessage(organizationId, user.id, message)
      if (!chat) {
        return reply.code(403).send({ error: "You are no longer in this chat" })
      }
      if (message.kind === "call") {
        return reply.code(400).send({ error: "A call message cannot be edited" })
      }
      if (saidByAi(message.doneVia)) return reply.code(403).send({ error: AI_WORDS })

      await db
        .update(messages)
        .set({
          content: body.content,
          isEdited: true,
          editedAt: new Date().toISOString(),
        })
        .where(eq(messages.id, id))

      const dto = await loadMessageDto(id)
      if (dto) emitToChat(organizationId, chat, "message-updated", { message: dto })
      const mentions = addedMentions(message.content, body.content)
      if (mentions.length > 0) void notify(organizationId, { type: "message", actorId: user.id, messageId: id, mentions })
      // A tag added by the edit asks the AI in a group, by the same rules as a new message, unless the message asked before
      if (chat.kind === "group" && !viaOf(request) && addedAiMention(message.content, body.content)) {
        mentionAi({
          asker: { userId: user.id, organizationId, isAdmin: role === "admin" },
          place: { kind: "group", id: chat.id },
          text: body.content,
          replyTo: { messageId: id },
          source: { kind: "message", id },
        })
      }

      return reply.send(dto)
    } catch (error) {
      logger.error("Error updating message:", error)
      return reply.code(500).send({ error: "Failed to update message" })
    }
  })

  fastify.put("/:id/pin", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(messageIdParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params
    const body = parseBody(messagePinBodySchema, request.body, reply)
    if (!body) return

    try {
      const { organizationId } = orgOf(request)
      const message = await db.query.messages.findFirst({
        where: and(
          eq(messages.id, id),
          isNull(messages.threadType),
          eq(messages.organizationId, organizationId),
          or(eq(messages.senderId, user.id), eq(messages.recipientId, user.id)),
        ),
      })

      const chat = message ? await chatForMessage(organizationId, user.id, message) : null
      if (!message || !chat) {
        return reply.code(404).send({ error: "Message not found or unauthorized" })
      }

      if (message.kind === "call") {
        return reply.code(400).send({ error: "A call message cannot be pinned" })
      }

      const { changed, ...pin } = await savePin(message, body.pinned)
      if (changed) {
        emitToChat(organizationId, chat, "message-pinned", {
          messageId: pin.id,
          is_pinned: pin.is_pinned,
          pinned_at: pin.pinned_at,
        })
      }

      return reply.send(pin)
    } catch (error) {
      logger.error("Error pinning message:", error)
      return reply.code(500).send({ error: "Failed to pin message" })
    }
  })

  fastify.post("/:id/reactions", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(messageIdParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params
    const body = parseBody(reactionBodySchema, request.body, reply)
    if (!body) return

    try {
      const { organizationId } = orgOf(request)
      const message = await db.query.messages.findFirst({
        where: and(
          eq(messages.id, id),
          isNull(messages.threadType),
          eq(messages.organizationId, organizationId),
          or(eq(messages.senderId, user.id), eq(messages.recipientId, user.id)),
        ),
      })

      const chat = message ? await chatForMessage(organizationId, user.id, message) : null
      if (!message || !chat) {
        return reply.code(404).send({ error: "Message not found or unauthorized" })
      }

      const existing = await db.query.messageReactions.findFirst({
        where: and(
          eq(messageReactions.messageId, id),
          eq(messageReactions.userId, user.id),
          eq(messageReactions.emoji, body.emoji),
          eq(messageReactions.organizationId, organizationId),
        ),
      })

      if (existing) {
        await db.delete(messageReactions).where(eq(messageReactions.id, existing.id))

        emitToChat(organizationId, chat, "reaction-removed", {
          messageId: id,
          emoji: body.emoji,
          userId: user.id,
        })

        return reply.send({
          action: "removed",
          emoji: body.emoji,
          messageId: id,
        })
      }

      const [reaction] = await db
        .insert(messageReactions)
        .values({
          messageId: id,
          userId: user.id,
          organizationId: organizationId,
          emoji: body.emoji,
        })
        .returning()

      const reactingUser = await db.query.users.findFirst({
        where: eq(users.id, user.id),
        columns: { id: true, firstName: true, lastName: true },
      })
      const reactionDto = {
        id: reaction.id,
        emoji: reaction.emoji,
        user_id: reaction.userId,
        user: {
          id: user.id,
          first_name: reactingUser?.firstName ?? null,
          last_name: reactingUser?.lastName ?? null,
        },
      }

      emitToChat(organizationId, chat, "reaction-added", { messageId: id, reaction: reactionDto })

      return reply.code(201).send({
        action: "added",
        reaction: reactionDto,
        messageId: id,
      })
    } catch (error) {
      logger.error("Error toggling reaction:", error)
      return reply.code(500).send({ error: "Failed to toggle reaction" })
    }
  })

  fastify.delete("/:id/attachments/:fileId", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(messageAttachmentParamsSchema, request.params, reply)
    if (!params) return
    const { organizationId } = orgOf(request)

    try {
      const message = await db.query.messages.findFirst({
        where: and(eq(messages.id, params.id), eq(messages.senderId, user.id), eq(messages.organizationId, organizationId)),
      })
      const chat = message ? await chatForMessage(organizationId, user.id, message) : null
      if (!chat) {
        return reply.code(404).send({ error: "Message not found or unauthorized" })
      }

      const removed = await db
        .delete(fileLinks)
        .where(and(eq(fileLinks.messageId, params.id), eq(fileLinks.fileId, params.fileId), eq(fileLinks.organizationId, organizationId)))
        .returning({ id: fileLinks.id })
      if (removed.length === 0) {
        return reply.code(404).send({ error: "File not found" })
      }
      void recheckDocConnections({ fileIds: [params.fileId] })

      const dto = await loadMessageDto(params.id)
      if (dto) emitToChat(organizationId, chat, "message-updated", { message: dto })
      return reply.send(dto)
    } catch (error) {
      logger.error("Error removing attachment:", error)
      return reply.code(500).send({ error: "Failed to remove attachment" })
    }
  })

  fastify.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user
    const params = parseParams(messageIdParamsSchema, request.params, reply)
    if (!params) return
    const { id } = params

    try {
      const { organizationId } = orgOf(request)
      const message = await db.query.messages.findFirst({
        where: and(eq(messages.id, id), eq(messages.senderId, user.id), eq(messages.organizationId, organizationId)),
      })

      if (!message) {
        return reply.code(404).send({ error: "Message not found or unauthorized" })
      }

      const chat = await chatForMessage(organizationId, user.id, message)
      if (!chat) {
        return reply.code(403).send({ error: "You are no longer in this chat" })
      }
      // A call room's access follows its message, so the message stays
      if (message.kind === "call") {
        return reply.code(400).send({ error: "A call message cannot be deleted" })
      }
      const { removed, fileIds } = await db.transaction(async (tx) => {
        const dropped = await dropNotifications(tx, organizationId, { messageId: id })
        const linked = await tx
          .select({ fileId: fileLinks.fileId })
          .from(fileLinks)
          .where(and(eq(fileLinks.messageId, id), eq(fileLinks.organizationId, organizationId)))
        await tx.delete(messages).where(eq(messages.id, id))
        return { removed: dropped, fileIds: linked.map((row) => row.fileId) }
      })
      emitToChat(organizationId, chat, "message-deleted", { messageId: id, pinned: message.isPinned })
      void announceRemoved(organizationId, removed)
      // The post may have been a user's only way to a paper or board they have open
      void recheckDocConnections({ fileIds })

      return reply.send({ message: "Message deleted successfully" })
    } catch (error) {
      logger.error("Error deleting message:", error)
      return reply.code(500).send({ error: "Failed to delete message" })
    }
  })
}

export default messageRoutes
