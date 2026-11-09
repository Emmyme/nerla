import { useEffect, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { aiAPI, type AiHeld, type AiHeldAnswer, type AiHeldStatus, type AiMessage, type AiPlace, type AiTeammate } from "@/lib/api/ai"
import { parseServerDate } from "@/lib/dates"
import { setAiMentionName } from "@/lib/mentions"
import { notifyTasksChanged } from "@/lib/taskStore"
import { onAiEvent, onAiHeldEvent, onSocketReconnect, type AiEvent } from "@/lib/socket"
import { startupRetryMs } from "@/lib/useBusyRetry"

const THREAD_PAGE = 50

type AiThreadStatus = "idle" | "loading" | "ready" | "error"

/** The user's DM with the AI, their running requests and the cards waiting for them. Kept apart from the chat store */
type AiState = {
  /** Null until the server has said whether the AI is there for the user */
  teammate: AiTeammate | null
  thread: { status: AiThreadStatus; messages: AiMessage[]; hasOlder: boolean; loadingOlder: boolean }
  running: string[]
  /** Where each running request answers */
  places: Record<string, AiPlace>
  /** Requests that answer in the DM */
  inDm: string[]
  /** The cards seen this session, with their state */
  held: AiHeld[]
  /** Open AI conversations on screen */
  viewing: number
  /** When the last request ended */
  endedAt: number | null
}

const EMPTY: AiState = {
  teammate: null,
  thread: { status: "idle", messages: [], hasOlder: false, loadingOlder: false },
  running: [],
  places: {},
  inDm: [],
  held: [],
  viewing: 0,
  endedAt: null,
}

let state: AiState = EMPTY
let stop: (() => void) | null = null
let generation = 0
// Bumped when the chat is cleared, so a page loading from before it never brings old messages back
let threadRun = 0
// Requests of a cleared chat, whose late messages stay out of it
const cleared = new Set<string>()
// Requests that ended before their start was known here, so a late answer never marks them running again
const ended = new Set<string>()
const ENDED_KEPT = 50
let teammateRetry: ReturnType<typeof setTimeout> | undefined
let teammateFailures = 0
const listeners = new Set<() => void>()

function commit(next: AiState) {
  state = next
  listeners.forEach((listener) => listener())
}

const update = (change: (current: AiState) => AiState) => commit(change(state))

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const getAiState = () => state

export function useAiSelect<T>(select: (current: AiState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state))
}

export const useAiTeammate = () => useAiSelect((current) => current.teammate)

function samePlace(a: AiPlace | null | undefined, b: AiPlace | null | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === "group" && b.kind === "group") return a.id.toLowerCase() === b.id.toLowerCase()
  if (a.kind === "task_comment" && b.kind === "task_comment") return a.taskId.toLowerCase() === b.taskId.toLowerCase()
  if (a.kind === "doc_comment" && b.kind === "doc_comment") return a.commentId.toLowerCase() === b.commentId.toLowerCase()
  return true
}

const open = (held: AiHeld, now: number) => held.status === "waiting" && (parseServerDate(held.expiresAt)?.getTime() ?? 0) > now

/** A card of the AI teammate's that still waits for the user's answer */
export const waitingFor = (current: AiState, now = Date.now()) => current.held.some((held) => held.source === "ai" && open(held, now))

/** Whether one of the user's requests is answering in the place right now */
export function useAiWorkingIn(place: AiPlace | null): boolean {
  return useAiSelect((current) => !!place && current.running.some((id) => samePlace(current.places[id], place)))
}

/** The cards for one place, as the user sees it */
export function useHeldIn(place: AiPlace | null): AiHeld[] {
  const held = useAiSelect((current) => current.held)
  return place ? held.filter((card) => card.source === "ai" && samePlace(card.place, place)) : []
}

function upsertMessage(messages: AiMessage[], message: AiMessage): AiMessage[] {
  const at = messages.findIndex((m) => m.id === message.id || (!!message.clientId && m.clientId === message.clientId))
  if (at < 0) return [...messages, message]
  const next = [...messages]
  next[at] = message
  return next
}

function withMessage(current: AiState, message: AiMessage): AiState {
  if (current.thread.status !== "ready" || (message.requestId && cleared.has(message.requestId))) return current
  return { ...current, thread: { ...current.thread, messages: upsertMessage(current.thread.messages, message) } }
}

const without = (list: string[], id: string) => (list.includes(id) ? list.filter((entry) => entry !== id) : list)
const adding = (list: string[], id: string) => (list.includes(id) ? list : [...list, id])

function onEvent(event: AiEvent) {
  if (event.type === "ai-thread-cleared") {
    resetThread()
  } else if (event.type === "ai-done") {
    if (event.message) update((current) => withMessage(current, event.message!))
  } else if (event.type === "ai-message") {
    update((current) => withMessage(current, event.message))
  } else if (event.status === "running") {
    if (ended.has(event.requestId)) return
    const { place } = event
    update((current) => ({
      ...current,
      running: adding(current.running, event.requestId),
      places: place ? { ...current.places, [event.requestId]: place } : current.places,
      inDm: place?.kind === "dm" ? adding(current.inDm, event.requestId) : current.inDm,
    }))
  } else {
    ended.add(event.requestId)
    // Only a late answer to a recent request needs it, so the oldest go
    if (ended.size > ENDED_KEPT) ended.delete(ended.values().next().value!)
    if (event.reason) toast.error(event.reason)
    // A tag that never started ran nothing, so the cat sleeps on and nothing reloads
    if (!state.running.includes(event.requestId)) return
    update((current) => {
      const { [event.requestId]: _, ...places } = current.places
      return { ...current, running: without(current.running, event.requestId), places, endedAt: Date.now() }
    })
    // What the AI did may have changed tasks on screen
    notifyTasksChanged()
  }
}

function onHeld(event: { type: "ai-held"; held: AiHeld } | { type: "ai-held-closed"; id: string; status: AiHeldStatus }) {
  if (event.type === "ai-held") {
    update((current) => ({ ...current, held: [...current.held.filter((card) => card.id !== event.held.id), event.held] }))
  } else {
    closeCard(event.id, event.status)
  }
}

function closeCard(id: string, status: AiHeldStatus, error?: string | null) {
  update((current) => {
    if (!current.held.some((card) => card.id === id && (card.status !== status || (!!error && card.error !== error)))) return current
    return {
      ...current,
      held: current.held.map((card) => (card.id === id ? { ...card, status, ...(error ? { error } : {}) } : card)),
      endedAt: Date.now(),
    }
  })
}

/** The server's reason for the first change that didn't go through, when it gave one */
export const failureOf = (answer: AiHeldAnswer): string | null => answer.results?.find((result) => !result.result.ok)?.result.error ?? null

async function loadHeld() {
  const run = generation
  try {
    const waiting = await aiAPI.held()
    if (run !== generation) return
    const ids = new Set(waiting.map((card) => card.id))
    // Cards closed elsewhere while this one was away read as closed, and the ones answered here stay as they are
    update((current) => ({
      ...current,
      held: [
        ...current.held
          .filter((card) => !ids.has(card.id))
          .map((card) => (card.status === "waiting" ? { ...card, status: "expired" as const } : card)),
        ...waiting,
      ],
    }))
  } catch {
    // The next reconnect asks again
  }
}

async function loadTeammate() {
  const run = generation
  clearTimeout(teammateRetry)
  try {
    const teammate = await aiAPI.teammate()
    if (run !== generation) return
    teammateFailures = 0
    setAiMentionName(teammate.name)
    update((current) => ({ ...current, teammate }))
    if (teammate.available) void loadHeld()
  } catch (err) {
    if (run !== generation) return
    if (!state.teammate) update((current) => ({ ...current, teammate: { available: false, name: "Nerla AI", avatarUrl: null } }))
    clearTimeout(teammateRetry)
    teammateRetry = setTimeout(() => void loadTeammate(), startupRetryMs(err, teammateFailures++))
  }
}

/** Asks again whether the AI is there, after its settings changed */
export const reloadAiTeammate = () => void loadTeammate()

async function loadLatest() {
  const run = generation
  const epoch = threadRun
  const page = await aiAPI.thread()
  if (run !== generation || epoch !== threadRun) return
  update((current) => {
    // Older pages scrolled back to, answers that came in meanwhile and messages being sent all stay
    const known = new Set(page.map((message) => message.id))
    const kept = current.thread.messages.filter((message) => !known.has(message.id))
    const at = (message: AiMessage) => parseServerDate(message.createdAt)?.getTime() ?? 0
    const messages = [...page, ...kept].sort((a, b) => at(a) - at(b))
    const hasOlder = current.thread.hasOlder || page.length >= THREAD_PAGE
    return { ...current, thread: { status: "ready", messages, hasOlder, loadingOlder: false } }
  })
}

/** Loads the DM's newest page the first time it is needed, and again after a failure */
export function ensureAiThread() {
  const status = state.thread.status
  if (status === "loading" || status === "ready") return
  update((current) => ({ ...current, thread: { ...current.thread, status: "loading" } }))
  loadLatest().catch(() => update((current) => ({ ...current, thread: { ...current.thread, status: "error" } })))
}

export async function loadOlderAi(): Promise<void> {
  const { thread } = state
  const first = thread.messages.find((message) => !message.id.startsWith("temp-"))
  if (!first || !thread.hasOlder || thread.loadingOlder) return
  const run = generation
  const epoch = threadRun
  update((current) => ({ ...current, thread: { ...current.thread, loadingOlder: true } }))
  try {
    const page = await aiAPI.thread(first.createdAt)
    if (run !== generation || epoch !== threadRun) return
    update((current) => {
      const known = new Set(current.thread.messages.map((message) => message.id))
      const older = page.filter((message) => !known.has(message.id))
      return {
        ...current,
        thread: {
          ...current.thread,
          messages: [...older, ...current.thread.messages],
          hasOlder: page.length >= THREAD_PAGE,
          loadingOlder: false,
        },
      }
    })
  } catch {
    if (run === generation) update((current) => ({ ...current, thread: { ...current.thread, loadingOlder: false } }))
    throw new Error("Couldn't load older messages.")
  }
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`

/** Sends a message to the AI. It shows at once, and a failure takes it back out and throws */
export async function askAi(content: string): Promise<void> {
  const clientId = newId()
  const local: AiMessage = {
    id: `temp-${clientId}`,
    role: "user",
    content,
    status: "done",
    requestId: null,
    createdAt: new Date().toISOString(),
    clientId,
  }
  update((current) => ({ ...current, thread: { ...current.thread, messages: [...current.thread.messages, local] } }))
  const run = generation
  try {
    const { requestId, message } = await aiAPI.ask(content, clientId)
    if (run !== generation) return
    update((current) => ({
      ...current,
      thread: { ...current.thread, messages: upsertMessage(current.thread.messages, { ...message, clientId }) },
      inDm: adding(current.inDm, requestId),
      running: ended.has(requestId) ? current.running : adding(current.running, requestId),
    }))
  } catch (error) {
    update((current) => ({ ...current, thread: { ...current.thread, messages: current.thread.messages.filter((m) => m.id !== local.id) } }))
    throw error
  }
}

export async function stopAi(requestId: string): Promise<void> {
  await aiAPI.stop(requestId)
}

/** Answers a card. Its new state shows at once, before the event from the server */
export async function answerCard(held: AiHeld, decision: "allow" | "deny", chosen: string[]): Promise<void> {
  const answer = await aiAPI.answerHeld(held.id, decision, held.kind === "changes" ? chosen : undefined)
  const reason = failureOf(answer)
  closeCard(held.id, answer.status, reason)
  if (reason) toast.error(reason)
  else if (answer.status === "failed") toast.error("This didn't go through.")
}

/** Empties the user's chat with the AI and drops its cards. Safe to run twice, as the event follows the answer here */
function resetThread() {
  threadRun += 1
  for (const id of state.inDm) cleared.add(id)
  update((current) => ({
    ...current,
    thread: { status: "ready", messages: [], hasOlder: false, loadingOlder: false },
    held: current.held.filter((card) => !(card.source === "ai" && card.place?.kind === "dm")),
  }))
}

/** Deletes the user's chat with the AI for good. The open chat empties at once and its cards go with it */
export async function clearAiChat(): Promise<void> {
  await aiAPI.clearThread()
  resetThread()
}

/** An AI conversation on screen keeps the cat awake */
export function useAiViewing(active: boolean) {
  useEffect(() => {
    if (!active) return
    update((current) => ({ ...current, viewing: current.viewing + 1 }))
    return () =>
      update((current) => ({ ...current, viewing: current.viewing - 1, endedAt: current.viewing === 1 ? Date.now() : current.endedAt }))
  }, [active])
}

/** From sign-in, so the cat and the cards know what runs and waits even before any AI view opens */
export function startAiStore() {
  if (stop) return
  const offs = [
    onAiEvent(onEvent),
    onAiHeldEvent(onHeld),
    onSocketReconnect(() => {
      // Whatever ran while the socket was down has been told to nobody, so the thread and cards load again
      update((current) => ({ ...current, running: [], places: {} }))
      void loadTeammate()
      if (state.thread.status === "ready") void loadLatest().catch(() => undefined)
    }),
  ]
  stop = () => offs.forEach((off) => off())
  void loadTeammate()
}

export function stopAiStore() {
  stop?.()
  stop = null
  generation += 1
  clearTimeout(teammateRetry)
  teammateFailures = 0
  ended.clear()
  cleared.clear()
  commit(EMPTY)
}
