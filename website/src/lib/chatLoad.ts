import { ApiError } from "@/lib/api/request"
import { groupChatsAPI, messagesAPI, type ChatKind, type ChatMessage } from "@/lib/api/chat"
import { messageOf } from "@/lib/taskStore"
import {
  type StoreMessage,
  store,
  watchers,
  loadingLatest,
  reloadAgain,
  restoring,
  deleted,
  usedAt,
  failedAt,
  olderLoads,
  peopleLoads,
  newerLoads,
  publish,
  commit,
  blankConversation,
  setConversation,
} from "@/lib/chatStore"
import {
  PAGE,
  chatKey,
  parseKey,
  isLocal,
  compareMessages,
  editedLater,
  mergePages,
  replaceMessage,
  planOlderRefetch,
} from "@/lib/chatModel"
import { scheduleListRefresh, sendRead } from "@/lib/chatList"

const MAX_CONVERSATIONS = 20
const MAX_DELETED = 500

const RESTORE_WINDOW_MS = 250
const REFETCH_LIMIT = 4

const LOAD_FAILED = "Couldn't load the chat. Check your connection and try again."

let pageRequest = 0
let useSeq = 0

export function loadPeople(key: string, id: string, count: number) {
  if (peopleLoads.has(key)) return
  peopleLoads.add(key)
  const at = store.generation
  groupChatsAPI
    .getGroupChat(id)
    .then((group) => {
      if (at !== store.generation) return
      const list = (group.members ?? []).flatMap((m) =>
        m.user
          ? [{ id: m.user_id, first_name: m.user.first_name, last_name: m.user.last_name, avatar_url: m.user.avatar_url ?? null }]
          : [],
      )
      store.people = { ...store.people, [key]: { count, list } }
      publish()
    })
    // The list's preview stands in until the next open
    .catch(() => undefined)
    .finally(() => peopleLoads.delete(key))
}

export function queueRestore(key: string, fileId: string) {
  const files = restoring.get(key) ?? new Set<string>()
  files.add(fileId)
  restoring.set(key, files)
  store.restoreTimer ??= setTimeout(() => void flushRestores(), RESTORE_WINDOW_MS)
}

/** At most `limit` at once, in order */
async function runLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++])
  })
  await Promise.all(lanes)
}

async function flushRestores(): Promise<void> {
  store.restoreTimer = undefined
  const batch = [...restoring]
  restoring.clear()
  const at = store.generation
  const singles: { key: string; message: ChatMessage; next: ChatMessage }[] = []
  for (const [key, fileIds] of batch) {
    const conversation = store.state.conversations[key]
    if (!conversation?.loaded || !watchers.has(key)) continue
    const plan = planOlderRefetch(conversation.messages, fileIds)
    if (plan.range) void reloadRange(key)
    else plan.targets.forEach((target) => singles.push({ key, ...target }))
  }
  await runLimited(singles, REFETCH_LIMIT, async ({ key, message, next }) => {
    const [kind, chatId] = parseKey(key)
    try {
      const found = (await messagesAPI.history(kind, chatId, { before: next, limit: 1 })).find((m) => m.id === message.id)
      if (found && at === store.generation) commit(replaceMessage(store.state, key, found), key)
    } catch {
      // The next open loads it fresh
      if (at === store.generation) setConversation(key, (conversation) => ({ ...conversation, stale: true }))
    }
  })
}

/** Many older messages changed, so every loaded page loads again once, newest first, down to the oldest shown */
async function reloadRange(key: string): Promise<void> {
  const at = store.generation
  setConversation(key, (conversation) => ({ ...conversation, stale: true }))
  const server = (store.state.conversations[key]?.messages ?? []).filter((m) => !isLocal(m))
  const oldest = server[0]
  if (!oldest) return
  const [kind, chatId] = parseKey(key)
  const pages: ChatMessage[] = []
  let before: ChatMessage | undefined
  try {
    for (let i = 0; i <= Math.ceil(server.length / PAGE); i++) {
      const page = await messagesAPI.history(kind, chatId, { before, limit: PAGE })
      pages.push(...page)
      if (page.length < PAGE || page.some((m) => m.id === oldest.id)) break
      before = page[0]
    }
  } catch {
    return
  }
  if (at !== store.generation) return
  const inRange = pages.filter(notDeleted).filter((m) => compareMessages(m, oldest) >= 0)
  setConversation(key, (conversation) => ({ ...conversation, messages: mergePages(conversation.messages, inRange), stale: false }))
}

export const notDeleted = (message: ChatMessage) => !deleted.has(message.id)

export function rememberDeleted(id: string) {
  deleted.add(id)
  if (deleted.size > MAX_DELETED) deleted.delete(deleted.values().next().value!)
}

function touchConversation(key: string) {
  usedAt.set(key, ++useSeq)
}

// A copy changed live while the page was out, by an edit or a reaction, is newer than the page
function changedSince(key: string) {
  const start = new Map((store.state.conversations[key]?.messages ?? []).map((m) => [m.id, m]))
  return (shown: StoreMessage, incoming: ChatMessage) => start.get(shown.id) !== shown || editedLater(shown, incoming)
}

export async function loadLatest(key: string): Promise<void> {
  if (loadingLatest.has(key)) return
  const id = ++pageRequest
  const at = store.generation
  const epoch = store.reconnects
  loadingLatest.set(key, id)
  touchConversation(key)
  const cached = new Set((store.state.conversations[key]?.messages ?? []).filter((m) => !isLocal(m)).map((m) => m.id))
  const keepShown = changedSince(key)
  setConversation(key, (c) => ({ ...c, status: c.loaded ? "ready" : "loading", error: null }))
  const [kind, chatId] = parseKey(key)
  let page: ChatMessage[]
  try {
    page = (await messagesAPI.history(kind, chatId, { limit: PAGE })).filter(notDeleted)
  } catch (err) {
    if (loadingLatest.get(key) === id) loadingLatest.delete(key)
    if (at !== store.generation) return
    if (reloadAgain.delete(key) && watchers.has(key)) return void loadLatest(key)
    failedAt.set(key, Date.now())
    setConversation(key, (c) => ({ ...c, status: c.loaded ? "ready" : "error", error: messageOf(err, LOAD_FAILED) }))
    // Refused or gone, as after leaving a group elsewhere, so the list catches up
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) scheduleListRefresh()
    return
  }
  failedAt.delete(key)
  if (loadingLatest.get(key) === id) loadingLatest.delete(key)
  if (at !== store.generation) return
  setConversation(key, (c) => {
    const newestShown = c.messages.filter((m) => !isLocal(m)).at(-1)
    // Missed more than a page while away, so the cache would have a hole in it
    const gap = page.length >= PAGE && !!newestShown && compareMessages(newestShown, page[0]) < 0
    const inPage = new Set(page.map((m) => m.id))
    const covered = (m: ChatMessage) => page.length < PAGE || compareMessages(m, page[0]) >= 0
    // A cached message missing from the span the page covers was deleted while the socket was down
    const kept = c.messages.filter((m) => isLocal(m) || !cached.has(m.id) || inPage.has(m.id) || !covered(m))
    const base = gap ? c.messages.filter(isLocal) : c.loaded ? kept : c.messages
    const hasOlder = c.loaded && !gap ? c.hasOlder : page.length >= PAGE
    return {
      ...c,
      messages: mergePages(base, page, keepShown),
      hasOlder,
      hasNewer: false,
      loaded: true,
      status: "ready",
      error: null,
      stale: epoch !== store.reconnects,
    }
  })
  evictConversations()
  // A reconnect or a restored file while the page was out leaves it stale, so it loads again
  const again = reloadAgain.delete(key)
  if ((epoch !== store.reconnects || again) && watchers.has(key)) void loadLatest(key)
}

// One older page at a time per chat, shared by scrolling and by a jump to an older message
export function loadOlder(key: string): Promise<void> {
  const running = olderLoads.get(key)
  if (running) return running
  const load = fetchOlder(key).finally(() => olderLoads.delete(key))
  olderLoads.set(key, load)
  return load
}

async function fetchOlder(key: string): Promise<void> {
  const conversation = store.state.conversations[key]
  if (!conversation?.loaded || !conversation.hasOlder || conversation.loadingOlder) return
  const oldest = conversation.messages.find((m) => !isLocal(m))
  if (!oldest) return setConversation(key, (c) => ({ ...c, hasOlder: false }))
  const at = store.generation
  const keepShown = changedSince(key)
  setConversation(key, (c) => ({ ...c, loadingOlder: true, error: null }))
  const [kind, chatId] = parseKey(key)
  try {
    const page = await messagesAPI.history(kind, chatId, { before: oldest, limit: PAGE })
    if (at !== store.generation) return
    setConversation(key, (c) => {
      // A reload replaced the cache meanwhile, so this page may not join onto it
      if (c.messages.find((m) => !isLocal(m))?.id !== oldest.id) return { ...c, loadingOlder: false }
      return {
        ...c,
        messages: mergePages(c.messages, page.filter(notDeleted), keepShown),
        hasOlder: page.length >= PAGE,
        loadingOlder: false,
      }
    })
  } catch (err) {
    if (at !== store.generation) return
    setConversation(key, (c) => ({ ...c, loadingOlder: false, error: messageOf(err, LOAD_FAILED) }))
  }
}

export function loadNewer(key: string): Promise<void> {
  const running = newerLoads.get(key)
  if (running) return running
  const load = fetchNewer(key).finally(() => newerLoads.delete(key))
  newerLoads.set(key, load)
  return load
}

async function fetchNewer(key: string): Promise<void> {
  const conversation = store.state.conversations[key]
  if (!conversation?.loaded || !conversation.hasNewer) return
  const newest = conversation.messages.filter((m) => !isLocal(m)).at(-1)
  if (!newest) return setConversation(key, (c) => ({ ...c, hasNewer: false }))
  const at = store.generation
  const keepShown = changedSince(key)
  setConversation(key, (c) => ({ ...c, loadingNewer: true, error: null }))
  const [kind, chatId] = parseKey(key)
  try {
    const page = await messagesAPI.history(kind, chatId, { after: newest, limit: PAGE })
    if (at !== store.generation) return
    setConversation(key, (c) => {
      if (!c.hasNewer || c.messages.filter((m) => !isLocal(m)).at(-1)?.id !== newest.id) return { ...c, loadingNewer: false }
      return {
        ...c,
        messages: mergePages(c.messages, page.filter(notDeleted), keepShown),
        hasNewer: page.length >= PAGE,
        loadingNewer: false,
      }
    })
  } catch (err) {
    if (at !== store.generation) return
    setConversation(key, (c) => ({ ...c, loadingNewer: false, error: messageOf(err, LOAD_FAILED) }))
  }
}

export function watch(key: string, active: boolean): () => void {
  const entry = watchers.get(key) ?? { count: 0, active: 0 }
  entry.count += 1
  if (active) entry.active += 1
  watchers.set(key, entry)
  touchConversation(key)
  return () => {
    entry.count -= 1
    if (active) entry.active -= 1
    if (entry.count === 0 && watchers.get(key) === entry) watchers.delete(key)
    if (active && entry.active === 0) sendRead(key)
    if (entry.count === 0) {
      trimConversation(key)
      evictConversations()
    }
  }
}

// A closed conversation keeps only its latest page, as if it were opened fresh
function trimConversation(key: string) {
  const conversation = store.state.conversations[key]
  const server = conversation?.messages.filter((m) => !isLocal(m)) ?? []
  // A page around an older message is not the latest, so the chat opens fresh next time
  if (conversation?.hasNewer) {
    const locals = conversation.messages.filter(isLocal)
    commit({ ...store.state, conversations: { ...store.state.conversations, [key]: { ...blankConversation(), messages: locals } } })
    return
  }
  if (!conversation?.loaded || server.length <= PAGE) return
  const latest = new Set(server.slice(-PAGE).map((m) => m.id))
  const messages = conversation.messages.filter((m) => isLocal(m) || latest.has(m.id))
  commit({ ...store.state, conversations: { ...store.state.conversations, [key]: { ...conversation, messages, hasOlder: true } } })
}

// Least recently used first. Open conversations and ones holding unsent messages stay.
function evictConversations() {
  const keys = Object.keys(store.state.conversations)
  if (keys.length <= MAX_CONVERSATIONS) return
  const idle = keys
    .filter((key) => !watchers.has(key) && !loadingLatest.has(key) && !store.state.conversations[key].messages.some(isLocal))
    .sort((a, b) => (usedAt.get(a) ?? 0) - (usedAt.get(b) ?? 0))
    .slice(0, keys.length - MAX_CONVERSATIONS)
  if (idle.length === 0) return
  const conversations = { ...store.state.conversations }
  for (const key of idle) {
    delete conversations[key]
    usedAt.delete(key)
  }
  commit({ ...store.state, conversations })
}

/**
 * Brings the message into the conversation: as it is when already loaded, otherwise one page around it,
 * which then pages both ways as the list scrolls. False when the message is not in this chat.
 */
export async function loadAround(kind: ChatKind, id: string, messageId: string): Promise<boolean> {
  const key = chatKey(kind, id)
  const conversation = store.state.conversations[key]
  if (!conversation?.loaded) return false
  if (conversation.messages.some((m) => m.id === messageId)) return true
  const at = store.generation
  let page: ChatMessage[]
  try {
    page = (await messagesAPI.history(kind, id, { around: messageId, limit: PAGE })).filter(notDeleted)
  } catch {
    return false
  }
  const index = page.findIndex((m) => m.id === messageId)
  if (at !== store.generation || index < 0) return false
  const newerAsked = Math.floor(PAGE / 2)
  setConversation(key, (c) => ({
    ...c,
    messages: mergePages(c.messages.filter(isLocal), page),
    hasOlder: index + 1 >= PAGE - newerAsked,
    hasNewer: page.length - index - 1 >= newerAsked,
    loadingOlder: false,
    loadingNewer: false,
    loaded: true,
    status: "ready",
    error: null,
  }))
  return true
}
