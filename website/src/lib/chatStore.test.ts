import { describe, expect, it } from "vitest"
import type { ChatMessage, ChatSummary } from "@/lib/api/chat"
import { applyChatEvent, applyFileChange, applyPin, chatKey, mergePages, planOlderRefetch } from "@/lib/chatModel"
import type { ChatState } from "@/lib/chatStore"

function message(id: string, at: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sender_id: "bob",
    recipient_id: null,
    thread_type: "group",
    thread_id: "g1",
    kind: "text",
    meta: null,
    live: false,
    content: id,
    is_read: false,
    is_edited: false,
    edited_at: null,
    created_at: at,
    reply_to_id: null,
    is_pinned: false,
    pinned_at: null,
    reply_to: null,
    sender: null,
    attachments: [],
    reactions: [],
    ...overrides,
  }
}

function chat(id: string, at: string, overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    kind: "group",
    id,
    title: id,
    project_id: null,
    members: [],
    member_count: 2,
    can_pin: true,
    last_message: null,
    last_activity_at: at,
    unread: false,
    ...overrides,
  }
}

const ids = (list: ChatMessage[]) => list.map((m) => m.id)

describe("mergePages", () => {
  it("prepends an older page without duplicates", () => {
    const shown = [message("m3", "2026-10-24 10:03:00"), message("m4", "2026-10-24 10:04:00")]
    const older = [message("m1", "2026-10-24 10:01:00"), message("m2", "2026-10-24 10:02:00"), message("m3", "2026-10-24 10:03:00")]
    expect(ids(mergePages(shown, older))).toEqual(["m1", "m2", "m3", "m4"])
  })

  it("keeps a live message that arrived during the load once", () => {
    const live = [message("m5", "2026-10-24 10:05:00")]
    const page = [message("m4", "2026-10-24 10:04:00"), message("m5", "2026-10-24 10:05:00")]
    expect(ids(mergePages(live, page))).toEqual(["m4", "m5"])
  })

  it("replaces a temp entry with the server message of the same client id", () => {
    const shown = [
      message("m1", "2026-10-24 10:01:00"),
      message("temp-c1", "2026-10-24T10:09:00.000Z", { client_id: "c1", sender_id: "me" }),
    ]
    const saved = message("m2", "2026-10-24 10:02:00", { client_id: "c1", sender_id: "me" })
    expect(ids(mergePages(shown, [saved]))).toEqual(["m1", "m2"])
  })

  it("keeps an edit already shown when a page from before it answers late", () => {
    const edited = message("m1", "2026-10-24 10:01:00", { content: "Fixed", is_edited: true, edited_at: "2026-10-24 10:05:00" })
    expect(mergePages([edited], [message("m1", "2026-10-24 10:01:00", { content: "Typo" })])[0].content).toBe("Fixed")
    const again = message("m1", "2026-10-24 10:01:00", { content: "Fixed again", is_edited: true, edited_at: "2026-10-24 10:06:00" })
    expect(mergePages([edited], [again])[0].content).toBe("Fixed again")
  })
})

describe("applyChatEvent", () => {
  const base = (): ChatState => ({
    me: "me",
    chats: [chat("g2", "2026-10-24 10:10:00"), chat("g1", "2026-10-24 09:00:00")],
    conversations: {},
  })

  it("marks a new message from another user unread and moves its chat to the top", () => {
    const next = applyChatEvent(base(), {
      type: "new-group-message",
      kind: "group",
      chatId: "g1",
      message: message("m1", "2026-10-24 10:20:00", { content: "Hello there" }),
    })
    expect(next.chats.map((c) => c.id)).toEqual(["g1", "g2"])
    expect(next.chats[0].unread).toBe(true)
    expect(next.chats[0].last_message?.preview).toBe("Hello there")
  })

  it("does not mark the user's own message from another device unread", () => {
    const next = applyChatEvent(base(), {
      type: "new-group-message",
      kind: "group",
      chatId: "g1",
      message: message("m1", "2026-10-24 10:20:00", { sender_id: "me" }),
    })
    expect(next.chats[0].id).toBe("g1")
    expect(next.chats[0].unread).toBe(false)
  })

  it("clears unread on chat-read, and keeps it clear when a message already shown arrives again", () => {
    const event = { type: "new-group-message", kind: "group", chatId: "g1", message: message("m1", "2026-10-24 10:20:00") } as const
    const read = applyChatEvent(applyChatEvent(base(), event), { type: "chat-read", kind: "group", id: "g1" })
    expect(read.chats[0].unread).toBe(false)
    expect(applyChatEvent(read, event).chats[0].unread).toBe(false)
  })

  it("removes a deleted message from a loaded conversation", () => {
    const key = chatKey("group", "g1")
    const state: ChatState = {
      ...base(),
      conversations: {
        [key]: {
          messages: [message("m1", "2026-10-24 10:01:00"), message("m2", "2026-10-24 10:02:00")],
          hasOlder: false,
          loaded: true,
          status: "ready",
          error: null,
          loadingOlder: false,
          stale: false,
        },
      },
    }
    const next = applyChatEvent(state, { type: "message-deleted", kind: "group", chatId: "g1", messageId: "m1" })
    expect(ids(next.conversations[key].messages)).toEqual(["m2"])
  })
})

describe("applyPin", () => {
  const pinned = (id: string, at: string) => message(id, "2026-10-24 09:00:00", { is_pinned: true, pinned_at: at })
  const list = [pinned("p2", "2026-10-24 12:00:00"), pinned("p1", "2026-10-24 11:00:00")]

  it("puts a new pin first and drops an unpinned one", () => {
    const added = applyPin(
      list,
      { messageId: "m3", is_pinned: true, pinned_at: "2026-10-24 13:00:00" },
      message("m3", "2026-10-24 10:00:00"),
    )
    expect(ids(added!)).toEqual(["m3", "p2", "p1"])
    expect(ids(applyPin(list, { messageId: "p2", is_pinned: false, pinned_at: null })!)).toEqual(["p1"])
  })

  it("asks for a reload when a new pin is not on this device", () => {
    expect(applyPin(list, { messageId: "m9", is_pinned: true, pinned_at: "2026-10-24 13:00:00" })).toBeNull()
  })

  it("keeps the chat's pin count with pins, unpins and deleted pins", () => {
    const state: ChatState = { me: "me", chats: [chat("g1", "2026-10-24 10:00:00", { pin_count: 1 })], conversations: {} }
    const pin = applyChatEvent(state, {
      type: "message-pinned",
      kind: "group",
      chatId: "g1",
      messageId: "m1",
      is_pinned: true,
      pinned_at: "2026-10-24 13:00:00",
    })
    expect(pin.chats[0].pin_count).toBe(2)
    const gone = applyChatEvent(pin, { type: "message-deleted", kind: "group", chatId: "g1", messageId: "m1", pinned: true })
    expect(gone.chats[0].pin_count).toBe(1)
  })
})

describe("file:changed", () => {
  const photo = {
    id: "f1",
    file_name: "photo.png",
    file_size: 10,
    mime_type: "image/png",
    created_at: "2026-10-24 10:00:00",
    alt_text: null,
    removed: false as const,
    removal_deadline: null,
  }
  const loaded = (messages: ChatMessage[]) => ({
    messages,
    hasOlder: false,
    loaded: true,
    status: "ready" as const,
    error: null,
    loadingOlder: false,
    stale: false,
  })
  const state = (): ChatState => ({
    me: "me",
    chats: [],
    conversations: {
      [chatKey("group", "g1")]: loaded([
        message("m1", "2026-10-24 10:01:00", { attachments: [photo] }),
        message("m2", "2026-10-24 10:02:00"),
      ]),
      [chatKey("dm", "bob")]: loaded([message("m3", "2026-10-24 10:03:00", { attachments: [photo] })]),
      [chatKey("group", "g2")]: loaded([message("m4", "2026-10-24 10:04:00")]),
    },
  })
  const event = (removed: boolean) => ({ type: "file:changed" as const, kind: "group" as const, chatId: "g1", fileId: "f1", removed })

  it("marks the file removed in every loaded conversation", () => {
    const { state: next, refetch } = applyFileChange(state(), event(true))
    expect(next.conversations[chatKey("group", "g1")].messages[0].attachments).toEqual([{ id: "f1", removed: true }])
    expect(next.conversations[chatKey("dm", "bob")].messages[0].attachments).toEqual([{ id: "f1", removed: true }])
    expect(refetch).toEqual([])
  })

  it("refetches the conversations holding a restored file", () => {
    const removed = applyFileChange(state(), event(true)).state
    const { state: next, refetch } = applyFileChange(removed, event(false))
    expect(next).toBe(removed)
    expect(refetch.sort()).toEqual([chatKey("dm", "bob"), chatKey("group", "g1")].sort())
  })
})

describe("planOlderRefetch", () => {
  const file = (id: string) => ({ id, file_name: `${id}.png`, file_size: 10, mime_type: "image/png", created_at: "2026-10-24 10:00:00" })
  const at = (i: number) => `2026-10-24 10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`
  // One older message with three files, then a full latest page after it
  const messages = [
    message("old", at(0), { attachments: [file("f1"), file("f2"), file("f3")] }),
    ...Array.from({ length: 50 }, (_, i) => message(`m${i}`, at(i + 1))),
  ]

  it("fetches a message once for a burst of restores of its files", () => {
    const plan = planOlderRefetch(messages, new Set(["f1", "f2", "f3"]))
    expect(plan.range).toBe(false)
    expect(plan.range ? [] : plan.targets.map((t) => [t.message.id, t.next.id])).toEqual([["old", "m0"]])
  })

  it("loads the range again once single fetches would cost more than its pages", () => {
    // 53 loaded messages are two pages, so three older messages to fetch one by one cost more
    const three = [
      message("o1", at(0), { attachments: [file("f1")] }),
      message("o2", at(1), { attachments: [file("f2")] }),
      message("o3", at(2), { attachments: [file("f3")] }),
      ...Array.from({ length: 50 }, (_, i) => message(`m${i}`, at(i + 3))),
    ]
    expect(planOlderRefetch(three, new Set(["f1", "f2"])).range).toBe(false)
    expect(planOlderRefetch(three, new Set(["f1", "f2", "f3"])).range).toBe(true)
  })
})
