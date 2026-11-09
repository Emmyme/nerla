import { fitContext, untrusted } from "./aiPrompt"
import type { AiAction, ItemRef } from "./aiTypes"

type Outcome = { ok: true; data: unknown; items?: unknown[]; target?: ItemRef } | { ok: false; error: string }

export const ACTIONS_MAX = 30
const NOTE_MAX = 2000

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const titleIn = (data: unknown): string | undefined => {
  const found = data as { title?: unknown; name?: unknown } | null
  const value = found?.title ?? found?.name
  return typeof value === "string" && value.trim() ? clip(value, 80) : undefined
}

const idIn = (data: unknown): string | undefined => {
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === "string" ? id.slice(0, 80) : undefined
}

/** What a call did, one action per change for a batch. A read that worked leaves none, only changes and failures are kept */
export function actionsOf(call: string, outcome: Outcome, write: boolean): AiAction[] {
  const tool = call.slice(0, 60)
  if (!outcome.ok) return [{ tool, ok: false, error: clip(outcome.error, 300) }]
  const batch = (outcome.data as { results?: { tool?: unknown; ok?: unknown; error?: unknown; data?: unknown }[] } | null)?.results
  if (Array.isArray(batch)) {
    return batch.map((entry) => {
      const name = typeof entry.tool === "string" ? entry.tool.slice(0, 60) : tool
      if (entry.ok !== true) return { tool: name, ok: false, error: clip(typeof entry.error === "string" ? entry.error : "It failed", 300) }
      return { tool: name, ok: true, id: idIn(entry.data), title: titleIn(entry.data) }
    })
  }
  if (!write) return []
  const action: AiAction = { tool, ok: true }
  if (outcome.target) {
    action.kind = outcome.target.kind
    action.id = outcome.target.id
  } else if (idIn(outcome.data)) {
    action.id = idIn(outcome.data)
  }
  const title = titleIn(outcome.data)
  if (title) action.title = title
  return [action]
}

const lineOf = (action: AiAction) => {
  if (!action.ok) return `- ${action.tool} failed: ${action.error ?? "no reason given"}`
  const what = [action.kind, action.id, action.title && `"${action.title}"`].filter(Boolean).join(" ")
  return `- ${action.tool} worked${what ? `: ${what}` : ""}`
}

/** The note after an earlier answer, saying which tools ran for it. Titles may be other users' words */
export function actionsNote(actions: AiAction[]): string {
  const lines = fitContext([], actions.slice(-ACTIONS_MAX).map(lineOf), NOTE_MAX)
  return untrusted("server note of the tools you ran for the answer above", lines)
}
