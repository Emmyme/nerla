import { randomUUID } from "node:crypto"
import type { FastifyReply, FastifyRequest } from "fastify"
import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { aiHeld, aiRequests, aiTokens, db } from "../db"
import { TRASH_TOOLS, type HeldItem } from "../utils/aiGate"
import { preferencesBlock } from "../utils/aiMemory"
import type { TokenScopes } from "../utils/aiTypes"
import { serverInstant } from "../utils/chatAccess"
import { logger } from "../utils/logger"
import { isRefusal } from "../utils/tenancy"
import { hashToken, sameHash, TOKEN_PREFIX, tokenLive } from "../utils/tokenScopes"
import { live } from "../live/live"
import { callTool, scopeAllows } from "./aiGate"
import { keepAlive, sweepHeld, type HeldClosed, type HeldResult } from "./aiCards"
import { preferencesFor } from "./aiMemory"
import { workspaceAi } from "./aiSettings"
import { ASK_PRIVATE, TOOLS, toolByName, toolSpecs, type ToolContext, type ToolDef, type ToolResult } from "./aiTools"
import { resolveOrg } from "./tenancy"
import { errorText } from "../utils/errorText"

const WAIT_FOR_ALLOW = "wait_for_allow"

const IDLE_MS = 30 * 60 * 1000
/** Under the 60 second request timeout MCP clients use by default, so the answer always arrives */
const WAIT_MS = 55 * 1000
const SESSIONS_PER_TOKEN = 10
const TOKEN_MAX = 200

type Agent = {
  tokenId: string
  tokenName: string
  tokenHash: string
  userId: string
  organizationId: string
  isAdmin: boolean
  scopes: TokenScopes
}

type Session = {
  id: string
  agent: Agent
  /** The session's one request, so taint lasts as long as the session */
  requestId: string
  transport: StreamableHTTPServerTransport
  lastSeen: number
  idle: NodeJS.Timeout | null
  ended: Promise<void> | null
  stopBeat: (() => void) | null
}

const sessions = new Map<string, Session>()

const INVALID = "Invalid or expired token"

/** The token's one live row, still in its owner's workspace with MCP on */
async function authenticate(hash: string): Promise<Agent | { refusal: string }> {
  // tenancy: the hash is the credential, so its row names the workspace, which is checked right below
  const rows = await db.select().from(aiTokens).where(eq(aiTokens.tokenHash, hash)).limit(5)
  const now = new Date()
  const valid = rows.filter((row) => sameHash(row.tokenHash, hash) && tokenLive(row, now))
  if (valid.length !== 1) return { refusal: INVALID }
  const [token] = valid
  const org = await resolveOrg(token.userId)
  if (isRefusal(org) || org.organizationId !== token.organizationId) return { refusal: INVALID }
  if (!(await workspaceAi(token.organizationId))?.mcpEnabled) return { refusal: "MCP access is off for this workspace" }
  await db
    .update(aiTokens)
    .set({ lastUsedAt: now.toISOString() })
    .where(and(eq(aiTokens.id, token.id), eq(aiTokens.organizationId, token.organizationId)))
  return {
    tokenId: token.id,
    tokenName: token.name,
    tokenHash: token.tokenHash,
    userId: token.userId,
    organizationId: token.organizationId,
    isAdmin: org.role === "admin",
    scopes: { areas: token.scopes, readOnly: token.readOnly },
  }
}

const contextOf = (session: Session, signal: AbortSignal): ToolContext => ({
  askerId: session.agent.userId,
  organizationId: session.agent.organizationId,
  isAdmin: session.agent.isAdmin,
  via: { kind: "agent", tokenId: session.agent.tokenId, tokenName: session.agent.tokenName },
  requestId: session.requestId,
  place: { kind: "mcp" },
  audience: null,
  scopes: session.agent.scopes,
  signal,
})

const waitInput = z.object({ id: z.string().uuid().describe("The action id from the waiting for Allow answer") })

const { $schema: _schema, ...waitSchema } = z.toJSONSchema(waitInput, { io: "input" })

const WAIT_TOOL: Tool = {
  name: WAIT_FOR_ALLOW,
  description:
    "Wait up to a minute for the user's answer to an action that is waiting for their Allow. Answers allowed with the results, denied, timed out or still waiting.",
  inputSchema: waitSchema as Tool["inputSchema"],
  annotations: { readOnlyHint: true },
}

const RESTORE = "restore_from_trash"

/** Hints for clients that warn before a delete. Nerla's own Allow is still the gate */
const hintsOf = (def: ToolDef): Pick<Tool, "annotations"> =>
  !def.write
    ? { annotations: { readOnlyHint: true } }
    : TRASH_TOOLS.includes(def.name) && def.name !== RESTORE
      ? { annotations: { destructiveHint: true } }
      : {}

/** A batch is offered only to a token that may make some change. A "kinds" tool is offered when any of its areas allows it */
const offered = (ctx: ToolContext, def: ToolDef) =>
  def.area === "both" ? TOOLS.some((tool) => tool.area !== "both" && tool.write && scopeAllows(ctx, tool)) : scopeAllows(ctx, def)

async function listTools(ctx: ToolContext): Promise<Tool[]> {
  const specs = await toolSpecs(ctx)
  const tools = specs
    .filter((spec) => {
      const def = toolByName(spec.function.name)
      // The private card is the AI teammate's own, never an agent's
      return !!def && def.name !== ASK_PRIVATE && !def.aiOnly && offered(ctx, def)
    })
    .map((spec) => ({
      name: spec.function.name,
      description: spec.function.description,
      inputSchema: spec.function.parameters as Tool["inputSchema"],
      ...hintsOf(toolByName(spec.function.name)!),
    }))
  return [...tools, WAIT_TOOL]
}

const text = (value: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError } : {}),
})

/** What a tool gives back: a write's data, or the items a read found */
function payloadOf(result: ToolResult & { ok: true }) {
  return { ...(result.data != null ? { data: result.data } : {}), ...(result.items ? { items: result.items } : {}) }
}

const isOpen = (status: string) => status === "waiting" || status === "allowed"

/** A card this token's agent made, in this session or an earlier one */
async function heldOf(session: Session, id: string) {
  const { organizationId, userId, tokenId } = session.agent
  const agentRequests = db
    .select({ id: aiRequests.id })
    .from(aiRequests)
    .where(and(eq(aiRequests.tokenId, tokenId), eq(aiRequests.organizationId, organizationId), eq(aiRequests.userId, userId)))
  const [row] = await db
    .select({ id: aiHeld.id, status: aiHeld.status, items: aiHeld.items, result: aiHeld.result, expiresAt: aiHeld.expiresAt })
    .from(aiHeld)
    .where(
      and(
        eq(aiHeld.id, id),
        eq(aiHeld.organizationId, organizationId),
        eq(aiHeld.userId, userId),
        inArray(aiHeld.requestId, agentRequests),
      ),
    )
    .limit(1)
  return row ?? null
}

type HeldState = NonNullable<Awaited<ReturnType<typeof heldOf>>>

function answerOf(row: HeldState): CallToolResult {
  if (row.status === "denied") return text("denied: the user did not allow this, so nothing ran.")
  if (row.status === "expired") return text("timed out: no answer came within 10 minutes, so nothing ran.")
  if (row.status !== "done") return text("failed: something went wrong while running the allowed changes.", true)
  const items = row.items as HeldItem[]
  const results = (row.result as HeldResult[] | null) ?? []
  const changes = new Map(items.map((item) => [item.id, item.summary]))
  const ran = new Set(results.map((entry) => entry.id))
  const body = {
    results: results.map((entry) => ({
      change: changes.get(entry.id) ?? entry.tool,
      tool: entry.tool,
      ...(entry.result.ok ? { ok: true, ...payloadOf(entry.result) } : { ok: false, error: entry.result.error }),
    })),
    notAllowed: items.filter((item) => !ran.has(item.id)).map((item) => item.summary),
  }
  return text(`allowed: ${JSON.stringify(body)}`)
}

/** Waits for the card to close, under a minute, and expires it once its 10 minutes are up */
async function waitForAllow(session: Session, args: unknown, signal: AbortSignal): Promise<CallToolResult> {
  const parsed = waitInput.safeParse(args ?? {})
  if (!parsed.success) return text(z.prettifyError(parsed.error), true)
  const { id } = parsed.data
  const { organizationId, userId } = session.agent
  let wake = () => {}
  const woken = new Promise<void>((resolve) => (wake = resolve))
  // The gate calls this after a card runs, so it must never throw
  const leave = live.subscribe(`held:${id}`, (closed) => {
    try {
      if ((closed as HeldClosed)?.organizationId === organizationId) wake()
    } catch {
      // nothing to do
    }
  })
  signal.addEventListener("abort", wake, { once: true })
  let timer: NodeJS.Timeout | undefined
  try {
    const row = await heldOf(session, id)
    if (!row) return text("not found", true)
    if (!isOpen(row.status)) return answerOf(row)
    const deadline = serverInstant(row.expiresAt)
    const wait = Math.max(0, Math.min(WAIT_MS, deadline - Date.now()))
    await Promise.race([woken, new Promise<void>((resolve) => (timer = setTimeout(resolve, wait)))])
    if (Date.now() >= deadline) await sweepHeld({ organizationId, userId })
    const now = await heldOf(session, id)
    if (now && !isOpen(now.status)) return answerOf(now)
    return text(`still waiting for Allow (action ${id}). Call wait_for_allow with this id again.`)
  } finally {
    clearTimeout(timer)
    leave()
    signal.removeEventListener("abort", wake)
  }
}

async function callFor(session: Session, name: string, args: unknown, signal: AbortSignal): Promise<CallToolResult> {
  if (name === WAIT_FOR_ALLOW) return waitForAllow(session, args, signal)
  const outcome = await callTool(contextOf(session, signal), name, args ?? {})
  if ("held" in outcome) {
    const changes = outcome.held.items.map((item) => item.summary).join(" | ")
    return text(`waiting for Allow (action ${outcome.held.id}): ${changes}. Call wait_for_allow with this id.`)
  }
  return outcome.ok ? text(JSON.stringify(payloadOf(outcome))) : text(outcome.error, true)
}

const INSTRUCTIONS =
  "These tools act in Nerla as the token's owner and see only what they can see. A change other people can see may wait for the owner's Allow. Then call wait_for_allow with the action id. A delete moves one thing to the trash, where it can be restored for 30 days, and every delete and restore waits for Allow. Nothing can be deleted for good."

/** The owner's own saved preferences are read once, as the session starts, so a change applies from the next one */
function serverFor(session: Session, preferences: string | null): Server {
  const server = new Server(
    { name: "nerla", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: preferences ? `${INSTRUCTIONS}\n\n${preferences}` : INSTRUCTIONS },
  )
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => ({
    tools: await listTools(contextOf(session, extra.signal)),
  }))
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    callFor(session, request.params.name, request.params.arguments, extra.signal),
  )
  return server
}

/** Ends the session's request once, however the session closed */
function finish(session: Session): Promise<void> {
  if (session.idle) clearTimeout(session.idle)
  session.stopBeat?.()
  if (sessions.get(session.id) === session) sessions.delete(session.id)
  return (session.ended ??= endRequest(session))
}

async function endRequest(session: Session) {
  if (!session.requestId) return
  try {
    await db
      .update(aiRequests)
      .set({ status: "done", finishedAt: new Date().toISOString() })
      .where(
        and(
          eq(aiRequests.id, session.requestId),
          eq(aiRequests.organizationId, session.agent.organizationId),
          eq(aiRequests.userId, session.agent.userId),
        ),
      )
  } catch (error) {
    logger.warn("Ending an MCP session's request failed", { error: errorText(error) })
  }
}

async function closeSession(session: Session) {
  try {
    await session.transport.close()
  } catch (error) {
    logger.warn("Closing an MCP session failed", { error: errorText(error) })
  }
  await finish(session)
}

/** Shutdown ends every session, its open stream and any wait_for_allow with it, so no reply holds the close */
export async function closeMcpSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map(closeSession))
}

function touch(session: Session) {
  session.lastSeen = Date.now()
  if (session.idle) clearTimeout(session.idle)
  session.idle = setTimeout(() => void closeSession(session), IDLE_MS)
  session.idle.unref()
}

/** A token keeps a few sessions at most, and the one used longest ago makes room */
async function makeRoom(tokenId: string) {
  const open = [...sessions.values()].filter((session) => session.agent.tokenId === tokenId).sort((a, b) => a.lastSeen - b.lastSeen)
  for (const session of open.slice(0, Math.max(0, open.length - SESSIONS_PER_TOKEN + 1))) await closeSession(session)
}

function rpcError(reply: FastifyReply, status: number, message: string) {
  if (status === 401) reply.header("WWW-Authenticate", 'Bearer realm="nerla"')
  return reply.code(status).send({ jsonrpc: "2.0", error: { code: -32001, message }, id: null })
}

function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null
  const token = header.slice("Bearer ".length).trim()
  return token.startsWith(TOKEN_PREFIX) && token.length <= TOKEN_MAX ? token : null
}

async function pass(request: FastifyRequest, reply: FastifyReply, transport: StreamableHTTPServerTransport) {
  reply.hijack()
  try {
    await transport.handleRequest(request.raw, reply.raw, request.body)
  } catch (error) {
    logger.error("An MCP request failed", error)
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { "Content-Type": "application/json" })
      reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Something went wrong" }, id: null }))
    }
  }
}

async function startSession(request: FastifyRequest, reply: FastifyReply, agent: Agent) {
  await makeRoom(agent.tokenId)
  const session = { id: "", agent, requestId: "", lastSeen: Date.now(), idle: null, ended: null, stopBeat: null } as Omit<
    Session,
    "transport"
  > as Session
  session.transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: async (id) => {
      // An outside agent's context is unknown to Nerla, so every session starts as having read another user's text
      const [row] = await db
        .insert(aiRequests)
        .values({
          organizationId: agent.organizationId,
          userId: agent.userId,
          source: "mcp",
          tokenId: agent.tokenId,
          place: { kind: "mcp" },
          tainted: true,
        })
        .returning({ id: aiRequests.id })
      session.id = id
      session.requestId = row.id
      session.stopBeat = keepAlive(agent.organizationId, row.id)
      sessions.set(id, session)
      touch(session)
    },
  })
  session.transport.onclose = () => void finish(session)
  const lines = await preferencesFor(agent.userId, agent.organizationId)
  await serverFor(session, lines ? preferencesBlock(lines, "mcp") : null).connect(session.transport)
  await pass(request, reply, session.transport)
  if (!session.id || sessions.get(session.id) !== session) await closeSession(session)
}

/**
 * Every request proves its token again, so a revoked or expired token, MCP turned off or an owner who left the
 * workspace stops the very next call and closes the session
 */
export async function handleMcp(request: FastifyRequest, reply: FastifyReply) {
  // Outside agents only. A browser always sends an Origin, so no web page can reach this
  if (request.headers.origin !== undefined) return rpcError(reply, 403, "Not available from a browser")
  const token = bearerOf(request)
  if (!token) return rpcError(reply, 401, INVALID)
  const hash = hashToken(token)
  const header = request.headers["mcp-session-id"]
  const sessionId = typeof header === "string" ? header : undefined
  const session = sessionId ? sessions.get(sessionId) : undefined
  const owns = !!session && sameHash(session.agent.tokenHash, hash)

  const agent = await authenticate(hash)
  if ("refusal" in agent) {
    if (owns) await closeSession(session)
    return rpcError(reply, 401, agent.refusal)
  }
  if (sessionId !== undefined) {
    if (!owns || session.agent.tokenId !== agent.tokenId) return rpcError(reply, 404, "Session not found")
    session.agent = agent
    touch(session)
    return pass(request, reply, session.transport)
  }
  if (request.method !== "POST" || !isInitializeRequest(request.body)) return rpcError(reply, 400, "Start a session first")
  return startSession(request, reply, agent)
}
