export type Strictness = "every" | "tainted" | "sensitive"

export type Via = { kind: "ai"; speaker?: "ai" } | { kind: "agent"; tokenId: string; tokenName: string }

/** The AI said it itself. Its words are never edited, not even by the user who asked */
export const saidByAi = (via: Via | null | undefined): boolean => via?.kind === "ai" && via.speaker === "ai"

export const AI_WORDS = "The AI's words can't be edited"

export type Place =
  | { kind: "dm" }
  | { kind: "group"; id: string }
  | { kind: "task_comment"; taskId: string }
  | { kind: "doc_comment"; fileId: string; commentId: string }
  | { kind: "mcp" }

export type ToolArea = "tasks" | "projects" | "calendar" | "papers" | "chat" | "files" | "time" | "people"

export type TokenScopes = { areas: Partial<Record<ToolArea, "read" | "write">>; readOnly: boolean }

export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: object } }

/** Something a tool returned or changed. A DM's id is `dm:{a}:{b}` with the two ids in order */
export type ItemRef = { kind: "task" | "project" | "doc" | "file" | "chat" | "event" | "person"; id: string }

/** One tool call an AI turn made and how it went, kept on its DM answer */
export type AiAction = { tool: string; ok: boolean; error?: string; kind?: ItemRef["kind"]; id?: string; title?: string }

/** From the most to the least often a write waits for Allow */
export const STRICTNESS_LEVELS: Strictness[] = ["every", "tainted", "sensitive"]
