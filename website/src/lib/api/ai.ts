import { request, get, post, put, del } from "@/lib/api/request"

export type AiStrictness = "every" | "tainted" | "sensitive"

/** How a thing was made for a user: by their AI teammate, which may have said it itself, or by one of their agents */
export type Via = { kind: "ai"; speaker?: "ai" } | { kind: "agent"; tokenId: string; tokenName: string }
export const AI_TOKEN_AREAS = ["tasks", "projects", "calendar", "papers", "chat", "files", "time"] as const
export type AiTokenArea = (typeof AI_TOKEN_AREAS)[number]
export type AiTokenScopes = Partial<Record<AiTokenArea, "read" | "write">>

/** The workspace's AI settings. The key itself never comes back, only its last 4 characters */
export interface WorkspaceAi {
  enabled: boolean
  mcpEnabled: boolean
  baseUrl: string | null
  model: string | null
  keyLast4: string | null
  name: string
  avatarUrl: string | null
  monthlyBudget: number | null
  personBudget: number | null
  allowPersonalKey: boolean
  allowPersonalUrl: boolean
  localNetwork: boolean
  strictness: AiStrictness
}

/** An empty key clears the saved one, and a missing key keeps it */
export type WorkspaceAiPatch = Partial<Omit<WorkspaceAi, "keyLast4" | "avatarUrl"> & { key: string; avatarFileId: string | null }>

/** What a user sees and may set. `allowKey` and `allowUrl` follow the workspace switches */
export interface PersonalAi {
  available: boolean
  mcpEnabled: boolean
  name: string
  avatarUrl: string | null
  allowKey: boolean
  allowUrl: boolean
  workspaceStrictness: AiStrictness
  baseUrl: string | null
  model: string | null
  keyLast4: string | null
  strictness: AiStrictness | null
}

type PersonalAiPatch = Partial<{ baseUrl: string | null; model: string | null; key: string; strictness: AiStrictness | null }>

export type AiHeldKind = "changes" | "share" | "reply"
export type AiHeldStatus = "waiting" | "allowed" | "denied" | "expired" | "done" | "failed"

/** One change on a card, with the exact values that run on Allow */
export interface AiHeldItem {
  id: string
  tool: string
  args: Record<string, unknown>
  summary: string
}

/** Where the AI was asked. An agent's requests are `mcp` */
export type AiPlace =
  | { kind: "dm" }
  | { kind: "group"; id: string }
  | { kind: "task_comment"; taskId: string }
  | { kind: "doc_comment"; fileId: string; commentId: string }
  | { kind: "mcp" }

/** A card waiting for the asker's Allow */
export interface AiHeld {
  id: string
  kind: AiHeldKind
  requestId: string
  source: "ai" | "mcp"
  tokenName: string | null
  /** Where its request was asked, so the card shows there for the asker */
  place?: AiPlace | null
  items: AiHeldItem[]
  status: AiHeldStatus
  expiresAt: string
  createdAt: string
  /** Why it didn't go through, kept on the card here once it was answered */
  error?: string | null
}

export interface AiHeldAnswer {
  id: string
  status: "done" | "denied" | "failed"
  results: { id: string; tool: string; result: { ok: boolean; error?: string } }[] | null
}

export type AiActivityResult = "ok" | "refused" | "held" | "denied" | "failed"

export interface AiActivityRow {
  id: string
  userId: string
  userName: string
  source: "ai" | "mcp"
  tokenId: string | null
  tokenName: string | null
  tool: string
  targetKind: string | null
  targetId: string | null
  result: AiActivityResult
  createdAt: string
}

export interface AiUsage {
  month: string
  used: number
  personalUsed: number
  personBudget: number | null
  reached: boolean
  workspace: {
    used: number
    monthlyBudget: number | null
    reached: boolean
    people: { userId: string; name: string; used: number; personalUsed: number }[]
  } | null
}

export interface AiToken {
  id: string
  name: string
  last4: string
  scopes: AiTokenScopes
  readOnly: boolean
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

export type AiTokenExpiry = 7 | 30 | 90 | 365 | null

/** Whether the AI teammate is there for the user, with its name and avatar */
export interface AiTeammate {
  available: boolean
  name: string
  avatarUrl: string | null
}

export type AiMessageStatus = "done" | "stopped" | "failed"

/** One message of the user's DM with the AI. `content` is cleaned text, never markup */
export interface AiMessage {
  id: string
  role: "user" | "assistant"
  content: string
  status: AiMessageStatus
  requestId: string | null
  createdAt: string
  clientId?: string | null
}

export interface AiPreferences {
  use: boolean
  lines: { id: string; text: string }[]
  /** When the list was last saved, null before the first save. A save sends it back as basedOn */
  updatedAt: string | null
}

/** The summary is plain text the model wrote, never markup */
export interface AiMemory {
  preferences: AiPreferences
  summary: { text: string; tainted: boolean; updatedAt: string | null } | null
}

// A connection test may wait on a slow model, so it gets the model client's own time
const MODEL_TEST_MS = 130000

export const aiAPI = {
  settings: (): Promise<WorkspaceAi> => get("/ai/settings"),
  saveSettings: (changes: WorkspaceAiPatch): Promise<WorkspaceAi> => put("/ai/settings", changes),
  testSettings: (): Promise<{ ok: boolean }> => request("/ai/settings/test", { method: "POST", timeoutMs: MODEL_TEST_MS }),
  me: (): Promise<PersonalAi> => get("/ai/me"),
  saveMe: (changes: PersonalAiPatch): Promise<PersonalAi> => put("/ai/me", changes),
  testMe: (): Promise<{ ok: boolean }> => request("/ai/me/test", { method: "POST", timeoutMs: MODEL_TEST_MS }),
  held: (): Promise<AiHeld[]> => get("/ai/held"),
  answerHeld: (id: string, decision: "allow" | "deny", chosen?: string[]): Promise<AiHeldAnswer> =>
    post(`/ai/held/${id}`, chosen ? { decision, chosen } : { decision }),
  activity: (scope: "mine" | "workspace"): Promise<AiActivityRow[]> => get(`/ai/activity?scope=${scope}`),
  usage: (): Promise<AiUsage> => get("/ai/usage"),
  tokens: (): Promise<AiToken[]> => get("/ai/tokens"),
  allTokens: (): Promise<(AiToken & { owner: { id: string; name: string } })[]> => get("/ai/tokens/all"),
  /** The only answer that holds the token's value */
  createToken: (body: {
    name: string
    expiresInDays: AiTokenExpiry
    scopes: AiTokenScopes
    readOnly: boolean
  }): Promise<AiToken & { token: string }> => post("/ai/tokens", body),
  revokeToken: (id: string): Promise<AiToken> => post(`/ai/tokens/${id}/revoke`),
  teammate: (): Promise<AiTeammate> => get("/ai/teammate"),
  /** 50 messages, oldest first, before the given time when there is one */
  thread: (before?: string): Promise<AiMessage[]> => get(`/ai/thread${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  ask: (content: string, clientId: string): Promise<{ requestId: string; message: AiMessage }> => post("/ai/thread", { content, clientId }),
  stop: (requestId: string): Promise<{ ok: boolean }> => post(`/ai/requests/${requestId}/stop`),
  /** The user's own saved preferences and chat summary, which no other user can read */
  memory: (): Promise<AiMemory> => get("/ai/me/memory"),
  savePreferences: (body: { use: boolean; lines: string[]; basedOn: string | null }): Promise<{ preferences: AiPreferences }> =>
    put("/ai/me/preferences", body),
  clearSummary: (): Promise<{ ok: boolean }> => del("/ai/me/summary"),
  /** Deletes the user's chat with the AI, its summary and the cards still waiting in it */
  clearThread: (): Promise<{ ok: boolean }> => del("/ai/thread"),
}
