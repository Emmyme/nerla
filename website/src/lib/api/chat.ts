import type { SymbolKey } from "@/components/ui/symbols"
import type { FolderColor } from "@/lib/folderColors"
import { get, post, put, patch, del } from "@/lib/api/request"
import type { Attachment } from "@/lib/api/files"
import type { Via } from "@/lib/api/ai"

export interface MessageReaction {
  id: string
  emoji: string
  user_id: string
  user?: {
    id: string
    first_name: string | null
    last_name: string | null
  } | null
}

interface MessageReplyTo {
  id: string
  content: string
  sender?: {
    id: string
    first_name: string | null
    last_name: string | null
  } | null
}

export type ChatKind = "dm" | "group"

export type MessageKind = "text" | "call"

/** One message of a DM or a group chat, as history and live events carry it */
export interface ChatMessage {
  id: string
  sender_id: string
  recipient_id: string | null
  thread_type: string | null
  thread_id: string | null
  kind: MessageKind
  /** A call message carries its room */
  meta: { roomName?: string } | null
  /** Only the chat's latest call can be live */
  live: boolean
  content: string
  is_read: boolean
  is_edited: boolean
  edited_at: string | null
  created_at: string
  reply_to_id: string | null
  is_pinned: boolean
  pinned_at: string | null
  reply_to: MessageReplyTo | null
  sender: {
    id: string
    email: string
    first_name: string | null
    last_name: string | null
    avatar_url: string | null
  } | null
  attachments: Attachment[]
  reactions: MessageReaction[]
  /** The sender's own id for a message it just sent, null otherwise */
  client_id?: string | null
  /** Made through the user's agent or AI */
  done_via?: Via | null
}

export interface ChatPerson {
  id: string
  first_name: string | null
  last_name: string | null
  avatar_url: string | null
}

/** A DM is keyed by the other user's id, a group by its own id */
export interface ChatSummary {
  kind: ChatKind
  id: string
  title: string
  project_id: string | null
  /** A group's symbol and colour key, or a project chat's symbol and hex. A DM has neither */
  icon?: string | null
  color?: string | null
  /** A group's own picture, shown in place of a symbol */
  avatar_url?: string | null
  /** Up to four members besides the viewer */
  members: ChatPerson[]
  member_count: number
  last_message: {
    id: string
    sender_id: string
    preview: string
    kind: MessageKind
    created_at: string
    live: boolean
    /** The AI said it, or an agent or the AI posted it for the sender */
    done_via?: Via | null
  } | null
  last_activity_at: string
  unread: boolean
  /** Anyone in a DM, a group's admins and creator */
  can_pin: boolean
  /** Pinned messages, calls left out. A chat made on this device has none yet. */
  pin_count?: number
}

export interface GroupChat {
  id: string
  name: string
  description?: string
  avatar_url?: string
  icon?: string | null
  color?: FolderColor | null
  organization_id: string
  project_id?: string | null
  created_by: string
  created_at: string
  updated_at: string
  member_count?: number
  unread_count?: number
  members?: GroupChatMember[]
}

interface GroupChatMember {
  id: string
  user_id: string
  role: string
  joined_at: string
  user?: {
    id: string
    email: string
    first_name: string
    last_name: string
    avatar_url?: string
  }
}

export const messagesAPI = {
  /** The newest messages before `before` (the oldest message already shown), oldest first */
  history: async (
    kind: ChatKind,
    id: string,
    options: {
      before?: Pick<ChatMessage, "id" | "created_at">
      /** The oldest messages after this one */
      after?: Pick<ChatMessage, "id" | "created_at">
      /** A page with this message in the middle, 404 when it is not in the chat */
      around?: string
      limit?: number
    } = {},
  ): Promise<ChatMessage[]> => {
    const query = new URLSearchParams()
    if (options.before) {
      query.set("before", options.before.created_at)
      query.set("beforeId", options.before.id)
    }
    if (options.after) {
      query.set("after", options.after.created_at)
      query.set("afterId", options.after.id)
    }
    if (options.around) query.set("around", options.around)
    if (options.limit) query.set("limit", String(options.limit))
    const search = query.toString() ? `?${query}` : ""
    return get(kind === "dm" ? `/messages/conversation/${id}${search}` : `/group-chats/${id}/messages${search}`)
  },

  sendMessage: async (
    recipientId: string,
    content: string,
    fileIds?: string[],
    replyToId?: string,
    clientId?: string,
  ): Promise<ChatMessage> => {
    return post("/messages", {
      recipientId,
      content,
      ...(fileIds && fileIds.length > 0 ? { fileIds } : {}),
      ...(replyToId ? { replyToId } : {}),
      ...(clientId ? { clientId } : {}),
    })
  },

  pinMessage: async (messageId: string, pinned: boolean): Promise<{ id: string; is_pinned: boolean; pinned_at: string | null }> => {
    return put(`/messages/${messageId}/pin`, { pinned })
  },

  markAsRead: async (contactId: string): Promise<void> => {
    await put(`/messages/read/${contactId}`)
  },

  /** Own messages only, in a DM or a group */
  editMessage: async (messageId: string, content: string): Promise<ChatMessage> => {
    return put(`/messages/${messageId}`, { content })
  },

  /** Own messages only, in a DM or a group */
  deleteMessage: async (messageId: string): Promise<void> => {
    await del(`/messages/${messageId}`)
  },

  toggleReaction: async (
    messageId: string,
    emoji: string,
  ): Promise<{ action: string; emoji: string; messageId: string; reaction?: MessageReaction }> => {
    return post(`/messages/${messageId}/reactions`, { emoji })
  },
}

export const groupChatsAPI = {
  getGroupChat: async (groupChatId: string): Promise<GroupChat> => {
    return get(`/group-chats/${groupChatId}`)
  },

  createGroupChat: async (data: {
    name: string
    description?: string
    member_ids: string[]
    icon?: SymbolKey | null
    color?: FolderColor | null
  }): Promise<GroupChat> => {
    return post("/group-chats", data)
  },

  /** Group admins only, and never a project chat */
  updateGroupChat: async (
    groupChatId: string,
    data: { icon?: SymbolKey | null; color?: FolderColor | null; avatar_file_id?: string | null },
  ): Promise<{ id: string; icon: string | null; color: FolderColor | null; avatar_url: string | null }> => {
    return patch(`/group-chats/${groupChatId}`, data)
  },

  addMember: async (groupChatId: string, userId: string): Promise<{ message: string }> => {
    return post(`/group-chats/${groupChatId}/members`, { user_id: userId })
  },

  removeMember: async (groupChatId: string, userId: string): Promise<{ message: string }> => {
    return del(`/group-chats/${groupChatId}/members/${userId}`)
  },

  sendMessage: async (
    groupChatId: string,
    content: string,
    fileIds?: string[],
    replyToId?: string,
    clientId?: string,
  ): Promise<ChatMessage> => {
    return post(`/group-chats/${groupChatId}/messages`, {
      content,
      ...(fileIds && fileIds.length > 0 ? { fileIds } : {}),
      ...(replyToId ? { replyToId } : {}),
      ...(clientId ? { clientId } : {}),
    })
  },

  markRead: async (groupChatId: string): Promise<void> => {
    await put(`/group-chats/${groupChatId}/read`)
  },

  pinMessage: async (
    groupChatId: string,
    messageId: string,
    pinned: boolean,
  ): Promise<{ id: string; is_pinned: boolean; pinned_at: string | null }> => {
    return put(`/group-chats/${groupChatId}/messages/${messageId}/pin`, { pinned })
  },

  toggleReaction: async (
    groupChatId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ action: string; emoji: string; messageId: string; reaction?: MessageReaction }> => {
    return post(`/group-chats/${groupChatId}/messages/${messageId}/reactions`, { emoji })
  },
}

export const chatsAPI = {
  list: async (): Promise<ChatSummary[]> => {
    return get("/chats")
  },

  /** Starts a call with everyone in the chat, or joins the one still running */
  call: async (kind: ChatKind, id: string): Promise<{ roomName: string }> => {
    return post(`/chats/${kind}/${id}/call`)
  },

  /** Up to 100 pinned messages, most recently pinned first */
  pins: async (kind: ChatKind, id: string): Promise<ChatMessage[]> => {
    return get(`/chats/${kind}/${id}/pins`)
  },
}
