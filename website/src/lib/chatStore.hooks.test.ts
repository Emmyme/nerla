// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ChatMessage, ChatSummary } from "@/lib/api/chat"
import type { ChatEvent } from "@/lib/socket"

const api = vi.hoisted(() => ({ list: vi.fn(), history: vi.fn(), sendGroup: vi.fn(), markGroupRead: vi.fn() }))
const socket = vi.hoisted(() => ({ emit: (_event: ChatEvent) => {} }))

vi.mock("@/lib/api/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/chat")>()
  return {
    ...actual,
    chatsAPI: { list: api.list },
    messagesAPI: { ...actual.messagesAPI, history: api.history },
    groupChatsAPI: { ...actual.groupChatsAPI, sendMessage: api.sendGroup, markRead: api.markGroupRead },
  }
})
vi.mock("@/lib/socket", () => ({
  onChatEvent: (callback: (event: ChatEvent) => void) => {
    socket.emit = callback
    return () => {}
  },
  onChatsChanged: () => () => {},
  onSocketReconnect: () => () => {},
  sendTyping: () => {},
}))

import { resetChatStore, setChatUser } from "@/lib/chatLive"
import { sendMessage } from "@/lib/chatSend"
import { useChats, useConversation } from "@/lib/chatHooks"

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
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
    created_at: "2026-10-24 10:00:00",
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

const chat = (id: string, unread: boolean): ChatSummary => ({
  kind: "group",
  id,
  title: id,
  project_id: null,
  members: [],
  member_count: 2,
  can_pin: true,
  last_message: null,
  last_activity_at: "2026-10-24 09:00:00",
  unread,
})

beforeEach(() => {
  vi.resetAllMocks()
  setChatUser({ id: "me", email: "me@example.com", firstName: "Me", lastName: "", avatarUrl: undefined })
  resetChatStore()
  api.list.mockResolvedValue([chat("g1", true), chat("g2", false)])
  api.history.mockResolvedValue([])
  api.markGroupRead.mockResolvedValue(undefined)
})

afterEach(() => {
  resetChatStore()
  vi.useRealTimers()
})

describe("chat store", () => {
  it("loads the list once, keeps an open chat read and marks a closed one unread", async () => {
    vi.useFakeTimers()
    const list = renderHook(() => useChats())
    const again = renderHook(() => useChats())
    const open = renderHook(() => useConversation("group", "g1"))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(open.result.current.status).toBe("ready")
    expect(list.result.current.status).toBe("ready")
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(again.result.current.chats.find((c) => c.id === "g1")?.unread).toBe(false)
    expect(api.markGroupRead).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(api.markGroupRead).toHaveBeenCalledTimes(1)

    act(() => {
      socket.emit({ type: "new-group-message", kind: "group", chatId: "g1", message: message("m1", { created_at: "2026-10-24 10:01:00" }) })
      socket.emit({ type: "new-group-message", kind: "group", chatId: "g1", message: message("m2", { created_at: "2026-10-24 10:02:00" }) })
      socket.emit({
        type: "new-group-message",
        kind: "group",
        chatId: "g2",
        message: message("m3", { thread_id: "g2", created_at: "2026-10-24 10:03:00" }),
      })
    })
    expect(open.result.current.messages.map((m) => m.id)).toEqual(["m1", "m2"])
    expect(list.result.current.chats.map((c) => [c.id, c.unread])).toEqual([
      ["g2", true],
      ["g1", false],
    ])
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(api.markGroupRead).toHaveBeenCalledTimes(2)
    expect(api.markGroupRead).toHaveBeenLastCalledWith("g1")
    ;[list, again, open].forEach((view) => view.unmount())
  })

  it("sends a pending read when the chat closes or hides, and leaves a later message unread", async () => {
    vi.useFakeTimers()
    let visibility: DocumentVisibilityState = "visible"
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
    const list = renderHook(() => useChats())
    const open = renderHook(({ id }) => useConversation("group", id), { initialProps: { id: "g1" as string | null } })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(api.markGroupRead).not.toHaveBeenCalled()
    const unread = () => list.result.current.chats.find((c) => c.id === "g1")?.unread

    open.rerender({ id: null })
    expect(api.markGroupRead).toHaveBeenCalledTimes(1)
    act(() =>
      socket.emit({
        type: "new-group-message",
        kind: "group",
        chatId: "g1",
        message: message("m1", { created_at: "2026-10-24 10:01:00" }),
      }),
    )
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(api.markGroupRead).toHaveBeenCalledTimes(1)
    expect(unread()).toBe(true)

    open.rerender({ id: "g1" })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(unread()).toBe(false)
    visibility = "hidden"
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(api.markGroupRead).toHaveBeenCalledTimes(2)
    act(() =>
      socket.emit({
        type: "new-group-message",
        kind: "group",
        chatId: "g1",
        message: message("m2", { created_at: "2026-10-24 10:02:00" }),
      }),
    )
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(api.markGroupRead).toHaveBeenCalledTimes(2)
    expect(unread()).toBe(true)
    ;[list, open].forEach((view) => view.unmount())
    spy.mockRestore()
  })

  it("swaps a sent message for the server copy once, and keeps a failed one with retry", async () => {
    const open = renderHook(() => useConversation("group", "g1"))
    await waitFor(() => expect(open.result.current.status).toBe("ready"))

    let answer: (value: ChatMessage) => void = () => {}
    api.sendGroup.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    let sent: Promise<void> = Promise.resolve()
    act(() => {
      sent = sendMessage("group", "g1", { content: "Hello" })
    })
    const temp = open.result.current.messages[0]
    expect(temp).toMatchObject({ content: "Hello", pending: true, sender_id: "me" })
    expect(temp.id.startsWith("temp-")).toBe(true)

    const saved = message("s1", { sender_id: "me", content: "Hello", client_id: temp.client_id })
    act(() => socket.emit({ type: "new-group-message", kind: "group", chatId: "g1", message: saved }))
    await act(async () => {
      answer(saved)
      await sent
    })
    expect(open.result.current.messages.map((m) => m.id)).toEqual(["s1"])

    api.sendGroup.mockRejectedValueOnce(new Error("offline"))
    await act(() => sendMessage("group", "g1", { content: "Still here" }))
    const failed = open.result.current.messages[1]
    expect(failed).toMatchObject({ content: "Still here", failed: true, pending: false })

    api.sendGroup.mockImplementationOnce(async () =>
      message("s2", { sender_id: "me", content: "Still here", client_id: failed.client_id, created_at: "2026-10-24 10:05:00" }),
    )
    await act(() => failed.retry!())
    expect(open.result.current.messages.map((m) => m.id)).toEqual(["s1", "s2"])
    open.unmount()
  })
})
