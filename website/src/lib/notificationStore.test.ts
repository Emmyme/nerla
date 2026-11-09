import { describe, expect, it } from "vitest"
import type { NotificationItem } from "@/lib/api/notifications"
import { applyNotificationEvent, EMPTY_NOTIFICATIONS, mentionPopup, mergePage, type NotificationState } from "./notificationStore"

function item(id: string, at: string, overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id,
    kind: "task_assigned",
    actor: { id: "bob", name: "Bob Test", avatarUrl: null },
    title: `Bob Test assigned you ${id}`,
    snippet: null,
    href: `/project/web?task=${id}`,
    changeCount: 1,
    read: false,
    createdAt: at,
    ...overrides,
  }
}

const state = (items: NotificationItem[], unread: number): NotificationState => ({ ...EMPTY_NOTIFICATIONS, items, unread, loaded: true })

describe("notification events", () => {
  it("adds a new item at the top and takes the count, but never lists a pop-up only item", () => {
    const before = state([item("a", "2026-10-27 09:00:00")], 1)
    const next = applyNotificationEvent(before, {
      type: "notification:new",
      item: item("b", "2026-10-27 10:00:00"),
      unread: 2,
      bell: true,
      desktop: true,
    })
    expect(next.items.map((i) => i.id)).toEqual(["b", "a"])
    expect(next.unread).toBe(2)

    const phantom = applyNotificationEvent(next, {
      type: "notification:new",
      item: item("p", "2026-10-27 11:00:00", { read: true }),
      unread: 2,
      bell: false,
      desktop: true,
    })
    expect(phantom.items.map((i) => i.id)).toEqual(["b", "a"])
  })

  it("replaces an updated item, moves it to the top and makes it unread", () => {
    const before = state([item("a", "2026-10-27 10:00:00"), item("b", "2026-10-27 09:00:00", { read: true, changeCount: 1 })], 1)
    const merged = item("b", "2026-10-27 11:00:00", { changeCount: 3, title: "Bob Test changed 3 things on WEB-1" })
    const next = applyNotificationEvent(before, { type: "notification:updated", item: merged, unread: 2 })
    expect(next.items.map((i) => i.id)).toEqual(["b", "a"])
    expect(next.items[0]).toMatchObject({ read: false, changeCount: 3, title: "Bob Test changed 3 things on WEB-1" })
    expect(next.unread).toBe(2)
  })

  it("sets the count on read, marks the ids read and drops the removed ones", () => {
    const before = state([item("a", "2026-10-27 11:00:00"), item("b", "2026-10-27 10:00:00"), item("c", "2026-10-27 09:00:00")], 3)
    const next = applyNotificationEvent(before, { type: "notification:read", unread: 1, ids: ["a"], removed: ["c"] })
    expect(next.unread).toBe(1)
    expect(next.items.map((i) => [i.id, i.read])).toEqual([
      ["a", true],
      ["b", false],
    ])
  })

  it("keeps one copy of an item a merge moved onto the next page", () => {
    const first = mergePage(
      EMPTY_NOTIFICATIONS,
      { items: [item("a", "2026-10-27 11:00:00"), item("b", "2026-10-27 10:00:00")], unread: 2, nextCursor: "c1" },
      true,
    )
    const more = mergePage(
      first,
      { items: [item("a", "2026-10-27 08:00:00"), item("c", "2026-10-27 07:00:00")], unread: 2, nextCursor: null },
      false,
    )
    expect(more.items.map((i) => i.id)).toEqual(["a", "b", "c"])
    expect(more.nextCursor).toBeNull()
  })
})

describe("mentionPopup", () => {
  it("gives the mention pop-up only when mention pop-ups are on, the chat rules when off or unknown, and nothing during Do not disturb", () => {
    expect(mentionPopup({ mentionDesktop: true, dnd: false })).toBe("mention")
    expect(mentionPopup({ mentionDesktop: false, dnd: false })).toBe("chat")
    expect(mentionPopup({ mentionDesktop: null, dnd: false })).toBe("chat")
    expect(mentionPopup({ mentionDesktop: true, dnd: true })).toBe("none")
    expect(mentionPopup({ mentionDesktop: false, dnd: true })).toBe("none")
    expect(mentionPopup({ mentionDesktop: null, dnd: true })).toBe("none")
  })
})
