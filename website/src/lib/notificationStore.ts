import { useSyncExternalStore } from "react"
import { notificationsAPI, type NotificationItem, type NotificationReadTarget, type UnreadPlace } from "@/lib/api/notifications"
import { parseServerDate } from "@/lib/dates"
import { claimForWindow } from "@/lib/meetingWindow"
import { notify } from "@/lib/notify"
import { doNotDisturb } from "@/lib/presenceStore"
import { onNotificationEvent, onSocketReconnect, type NotificationEvent } from "@/lib/socket"

export type NotificationState = {
  unread: number
  items: NotificationItem[]
  /** The first page is in, so `items` is the list rather than only what arrived live */
  loaded: boolean
  nextCursor: string | null
  /** Unread notifications that point at a task or a chat, by id, so reaching that place can read them */
  places: Record<string, string>
}

type ListStatus = "idle" | "loading" | "ready" | "error"

export const EMPTY_NOTIFICATIONS: NotificationState = { unread: 0, items: [], loaded: false, nextCursor: null, places: {} }

// A chat read reads its mentions on the server too, so a chat waits a moment before asking on its own
const CHAT_READ_WAIT_MS = 1500

// --- Pure helpers ---

/** "task:<id>", "dm:<id>" or "group:<id>", from the link the server built */
function placeOf(href: string | null): string | null {
  if (!href) return null
  const params = new URLSearchParams(href.split("?")[1] ?? "")
  const task = params.get("task")
  if (task) return `task:${task.toLowerCase()}`
  for (const kind of ["dm", "group"] as const) {
    const id = params.get(kind)
    if (id && href.startsWith("/messages")) return `${kind}:${id.toLowerCase()}`
  }
  return null
}

function targetOf(place: string): NotificationReadTarget {
  const at = place.indexOf(":")
  const kind = place.slice(0, at)
  const id = place.slice(at + 1)
  return kind === "task" ? { taskId: id } : { chat: { kind: kind as "dm" | "group", id } }
}

const timeOf = (value: string) => parseServerDate(value)?.getTime() ?? 0
const newestFirst = (a: NotificationItem, b: NotificationItem) => timeOf(b.createdAt) - timeOf(a.createdAt) || (a.id < b.id ? 1 : -1)

function withPlaces(places: Record<string, string>, items: NotificationItem[]): Record<string, string> {
  const next = { ...places }
  for (const item of items) {
    const place = placeOf(item.href)
    if (!item.read && place) next[item.id] = place
    else delete next[item.id]
  }
  return next
}

function withoutIds(places: Record<string, string>, ids: string[]): Record<string, string> {
  if (!ids.some((id) => id in places)) return places
  const next = { ...places }
  for (const id of ids) delete next[id]
  return next
}

function hasUnreadAt(state: NotificationState, place: string): boolean {
  return Object.values(state.places).includes(place)
}

export function applyNotificationEvent(state: NotificationState, event: NotificationEvent): NotificationState {
  if (event.type === "notification:prefs") return state
  if (event.type === "notification:read") {
    const read = new Set(event.ids ?? [])
    const removed = new Set(event.removed ?? [])
    const items = state.items
      .filter((i) => !removed.has(i.id))
      .map((i) => (!i.read && (read.has(i.id) || event.unread === 0) ? { ...i, read: true } : i))
    const places = event.unread === 0 ? {} : withoutIds(state.places, [...read, ...removed])
    return { ...state, unread: event.unread, items, places }
  }
  // A pop-up without a bell entry only shows, and never joins the list
  if (event.type === "notification:new" && !event.bell) return { ...state, unread: event.unread }
  return {
    ...state,
    unread: event.unread,
    items: [event.item, ...state.items.filter((i) => i.id !== event.item.id)],
    places: withPlaces(state.places, [event.item]),
  }
}

/** A page from the server. A merge moves an entry's time, so an id already shown is never shown twice */
export function mergePage(
  state: NotificationState,
  page: { items: NotificationItem[]; unread: number; nextCursor: string | null },
  first: boolean,
): NotificationState {
  const ids = new Set(page.items.map((i) => i.id))
  const items = first
    ? [...page.items, ...state.items.filter((i) => !ids.has(i.id))].sort(newestFirst)
    : [...state.items, ...page.items.filter((i) => !state.items.some((shown) => shown.id === i.id))]
  return { ...state, items, unread: page.unread, loaded: true, nextCursor: page.nextCursor, places: withPlaces(state.places, page.items) }
}

/** Marks what points at a place read here at once, ahead of the server */
function readPlace(state: NotificationState, place: string): NotificationState {
  const ids = Object.keys(state.places).filter((id) => state.places[id] === place)
  return {
    ...state,
    unread: Math.max(0, state.unread - ids.length),
    items: state.items.map((i) => (!i.read && ids.includes(i.id) ? { ...i, read: true } : i)),
    places: withoutIds(state.places, ids),
  }
}

/**
 * The pop-up for a chat message that mentions the user. With mention pop-ups on, the mention's own pop-up stands in for the
 * chat's. With them off, or not known yet, the chat's usual rules apply. Do not disturb shows neither.
 */
export function mentionPopup({ mentionDesktop, dnd }: { mentionDesktop: boolean | null; dnd: boolean }): "mention" | "chat" | "none" {
  if (dnd) return "none"
  return mentionDesktop === true ? "mention" : "chat"
}

// --- Store ---

type Snapshot = NotificationState & { status: ListStatus; loadingMore: boolean; stale: boolean }

let state: NotificationState = EMPTY_NOTIFICATIONS
let status: ListStatus = "idle"
let loadingMore = false
let stale = false
let snapshot: Snapshot = { ...state, status, loadingMore, stale }
// Unknown until the summary or a prefs event says
let mentionDesktop: boolean | null = null
let generation = 0
let stop: (() => void) | null = null
const listeners = new Set<() => void>()
const readers = new Set<(place: string) => boolean>()
const pendingReads = new Map<string, ReturnType<typeof setTimeout>>()

function publish() {
  snapshot = { ...state, status, loadingMore, stale }
  listeners.forEach((listener) => listener())
}

function commit(next: NotificationState) {
  if (next === state) return
  state = next
  publish()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const isOpenHere = (place: string) => [...readers].some((reads) => reads(place))

function popUp(item: NotificationItem) {
  if (typeof document === "undefined" || !item.href || doNotDisturb()) return
  const place = placeOf(item.href)
  const away = document.visibilityState !== "visible" || !document.hasFocus()
  const seen = !away || (!!place && isOpenHere(place))
  const href = item.href
  void claimForWindow(`notification:${item.id}`, { preferred: seen }).then((mine) => {
    if (!mine || seen) return
    void notify("Nerla", {
      body: item.snippet ? `${item.title}\n${item.snippet}` : item.title,
      tag: `notification-${item.id}`,
      onClick: () => void import("@/router").then(({ router }) => router.navigate(href)),
    })
  })
}

function onEvent(event: NotificationEvent) {
  if (event.type === "notification:prefs") {
    mentionDesktop = event.prefs.mentioned.desktop
    return
  }
  commit(applyNotificationEvent(state, event))
  if (event.type === "notification:read") return
  if (event.type === "notification:new" && event.desktop) popUp(event.item)
  const place = placeOf(event.item.href)
  if (place && !event.item.read && isOpenHere(place)) readNotificationsAt(place)
}

function placesFrom(list: UnreadPlace[]): Record<string, string> {
  const places: Record<string, string> = {}
  for (const { id, taskId, chat } of list) {
    if (taskId) places[id] = `task:${taskId.toLowerCase()}`
    else if (chat) places[id] = `${chat.kind}:${chat.id.toLowerCase()}`
  }
  return places
}

async function loadSummary() {
  const at = generation
  try {
    const summary = await notificationsAPI.summary()
    if (at !== generation) return
    mentionDesktop = summary.mentionDesktop
    commit({ ...state, unread: summary.unread, places: placesFrom(summary.places) })
    readOpenPlaces()
  } catch {
    // The dot waits for the next event or reconnect
  }
}

async function loadPage(first: boolean) {
  const at = generation
  if (first) status = "loading"
  else loadingMore = true
  publish()
  try {
    const reload = first && stale
    const page = await notificationsAPI.list(first ? null : state.nextCursor)
    if (at !== generation) return
    if (first) {
      status = "ready"
      stale = false
    }
    // After a reconnect the fresh first page stands alone, so nothing missed while away lingers
    commit(mergePage(reload ? { ...state, items: [] } : state, page, first))
  } catch {
    if (at !== generation) return
    if (first) status = "error"
  } finally {
    if (at === generation) {
      loadingMore = false
      publish()
    }
  }
}

/** Reads what points at a place on screen here, as when the window comes back or the unread places arrive */
function readOpenPlaces() {
  if (typeof document === "undefined" || document.visibilityState !== "visible") return
  for (const place of new Set(Object.values(state.places))) if (isOpenHere(place)) readNotificationsAt(place)
}

/** Starts with the socket, on sign-in: one request for the dot, then the socket keeps it current */
export function startNotifications() {
  if (stop) return
  const offs = [
    onNotificationEvent(onEvent),
    onSocketReconnect(() => {
      stale = state.loaded
      void loadSummary()
    }),
  ]
  document.addEventListener("visibilitychange", readOpenPlaces)
  stop = () => {
    offs.forEach((off) => off())
    document.removeEventListener("visibilitychange", readOpenPlaces)
  }
  void loadSummary()
}

export function stopNotifications() {
  stop?.()
  stop = null
  generation += 1
  pendingReads.forEach(clearTimeout)
  pendingReads.clear()
  state = EMPTY_NOTIFICATIONS
  status = "idle"
  loadingMore = false
  stale = false
  mentionDesktop = null
  publish()
}

/** The first page loads on the first open, and again after the socket came back */
export function loadNotifications() {
  if (status === "loading" || (status === "ready" && !stale)) return
  void loadPage(true)
}

export function loadMoreNotifications() {
  if (loadingMore || !state.nextCursor || status !== "ready") return
  void loadPage(false)
}

/** Opening one reads it */
export function readNotification(item: NotificationItem) {
  if (item.read) return
  commit({
    ...state,
    unread: Math.max(0, state.unread - 1),
    items: state.items.map((i) => (i.id === item.id ? { ...i, read: true } : i)),
    places: withoutIds(state.places, [item.id]),
  })
  notificationsAPI.read({ ids: [item.id] }).then(takeUnread, () => undefined)
}

function takeUnread({ unread }: { unread: number }) {
  if (state.unread !== unread) commit({ ...state, unread })
}

export async function readAllNotifications(): Promise<boolean> {
  const at = generation
  const flipped = new Set(state.items.filter((i) => !i.read).map((i) => i.id))
  commit({ ...state, unread: 0, items: state.items.map((i) => (i.read ? i : { ...i, read: true })), places: {} })
  try {
    takeUnread(await notificationsAPI.readAll())
    return true
  } catch {
    if (at !== generation) return false
    // Only what this flipped goes back, and the count and places come from the server again
    commit({ ...state, items: state.items.map((i) => (flipped.has(i.id) && i.read ? { ...i, read: false } : i)) })
    void loadSummary()
    return false
  }
}

/** Reaching a place reads what points at it, and only asks the server when something there is unread */
export function readNotificationsAt(place: string) {
  if (pendingReads.has(place) || !hasUnreadAt(state, place)) return
  const at = generation
  pendingReads.set(
    place,
    setTimeout(
      () => {
        pendingReads.delete(place)
        if (at !== generation || !hasUnreadAt(state, place)) return
        commit(readPlace(state, place))
        notificationsAPI.read(targetOf(place)).then(takeUnread, () => undefined)
      },
      place.startsWith("task:") ? 0 : CHAT_READ_WAIT_MS,
    ),
  )
}

/** Says which places are on screen, so what arrives for them is read there and then */
export function watchNotificationPlaces(isOpen: (place: string) => boolean): () => void {
  readers.add(isOpen)
  return () => {
    readers.delete(isOpen)
  }
}

/** Whether a mention's pop-up stands in for the chat's, as the user's settings say, or null while unknown */
export function mentionPopupsOn(): boolean | null {
  return mentionDesktop
}

export function setMentionPopups(on: boolean) {
  mentionDesktop = on
}

export function useNotifications(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

export function useUnreadNotifications(): number {
  return useSyncExternalStore(subscribe, () => snapshot.unread)
}
