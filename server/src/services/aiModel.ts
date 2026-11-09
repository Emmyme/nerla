import { lookup } from "node:dns/promises"
import http, { type IncomingMessage } from "node:http"
import https from "node:https"
import { isIP, type LookupFunction } from "node:net"
import { and, eq, sql } from "drizzle-orm"
import { aiUsage, db } from "../db"
import type { Place, ToolSpec } from "../utils/aiTypes"
import { logger } from "../utils/logger"
import { addressAllowed, checkModelUrl } from "../utils/modelAddress"
import { parseChatStream, type ChatMessage, type StreamEvent } from "../utils/modelStream"
import { modelChoice, personalAi, workspaceAi, type ModelChoice } from "./aiSettings"

const CONNECT_MS = 20_000
const TOTAL_MS = 120_000
const MAX_RESPONSE_CHARS = 8 * 1024 * 1024
const TEST_MS = 90_000

/** Whatever went wrong, the user only ever learns this. The reason goes to the server log */
export class ModelUnreachable extends Error {
  constructor(readonly reason = "failed") {
    super("Couldn't connect")
    this.name = "ModelUnreachable"
  }
}

/** A personal model or key answers only in the user's own DM, and everything else uses the workspace's */
export async function modelFor(asker: { userId: string; organizationId: string }, place: Place): Promise<ModelChoice | null> {
  const org = await workspaceAi(asker.organizationId)
  const personal = place.kind === "dm" ? await personalAi(asker.userId, asker.organizationId) : null
  return modelChoice(org, personal)
}

/** Resolves the host, checks every answer and settles on the first, so the connection can't land anywhere else */
async function pinnedTarget(choice: ModelChoice) {
  const checked = checkModelUrl(choice.baseUrl, { local: choice.local })
  if (!checked.ok) throw new ModelUnreachable("address refused")
  const url = checked.url
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const family = isIP(host)
  const answers = family ? [{ address: host, family }] : await lookup(host, { all: true })
  if (!answers.length || !answers.every((answer) => addressAllowed(answer.address, { local: choice.local }))) {
    throw new ModelUnreachable("resolved address refused")
  }
  return { url, host, ip: answers[0].address, family: answers[0].family }
}

async function* decoded(response: IncomingMessage): AsyncIterable<string> {
  response.setEncoding("utf8")
  let size = 0
  for await (const part of response as AsyncIterable<string>) {
    size += part.length
    if (size > MAX_RESPONSE_CHARS) throw new ModelUnreachable("response too large")
    yield part
  }
}

/**
 * Streams a chat completion. The connection is pinned to the checked address and no redirect is followed,
 * and nothing the model server sent is ever put in an error. A stop through `signal` ends the stream quietly
 */
export async function* streamChat(
  choice: ModelChoice,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal: AbortSignal,
  options: { maxTokens?: number } = {},
): AsyncIterable<StreamEvent> {
  if (signal.aborted) return
  let request: http.ClientRequest | undefined
  let connectTimer: NodeJS.Timeout | undefined
  let totalTimer: NodeJS.Timeout | undefined
  const stop = () => request?.destroy()
  signal.addEventListener("abort", stop, { once: true })
  try {
    const { url, host, ip, family } = await pinnedTarget(choice)
    const secure = url.protocol === "https:"
    const body = JSON.stringify({
      model: choice.model,
      messages,
      ...(tools.length ? { tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    })
    const pinnedLookup: LookupFunction = (_host, lookupOptions, callback) =>
      lookupOptions.all ? callback(null, [{ address: ip, family }]) : callback(null, ip, family)

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      request = (secure ? https : http).request(
        {
          hostname: host,
          port: url.port || undefined,
          path: `${url.pathname.replace(/\/+$/, "")}/chat/completions`,
          method: "POST",
          agent: false,
          lookup: pinnedLookup,
          ...(secure && !isIP(host) ? { servername: host } : {}),
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Accept: "text/event-stream",
            ...(choice.key ? { Authorization: `Bearer ${choice.key}` } : {}),
          },
        },
        resolve,
      )
      connectTimer = setTimeout(() => request?.destroy(new Error("connect timeout")), CONNECT_MS)
      totalTimer = setTimeout(() => request?.destroy(new Error("timeout")), TOTAL_MS)
      request.once("socket", (socket) => socket.once(secure ? "secureConnect" : "connect", () => clearTimeout(connectTimer)))
      request.once("error", reject)
      if (signal.aborted) request.destroy()
      request.end(body)
    })

    const status = response.statusCode ?? 0
    if (status < 200 || status >= 300) {
      response.destroy()
      throw new ModelUnreachable(`status ${status}`)
    }
    yield* parseChatStream(decoded(response))
  } catch (error) {
    if (signal.aborted) return
    const failure = error instanceof ModelUnreachable ? error : new ModelUnreachable(reasonOf(error))
    logger.warn("Model request failed", { reason: failure.reason })
    throw failure
  } finally {
    clearTimeout(connectTimer)
    clearTimeout(totalTimer)
    signal.removeEventListener("abort", stop)
    request?.destroy()
  }
}

const reasonOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.name : "failed")

/** A 1-token completion. Whatever the model server says stays out of the answer */
export async function testModel(choice: ModelChoice): Promise<boolean> {
  const signal = AbortSignal.timeout(TEST_MS)
  try {
    for await (const event of streamChat(choice, [{ role: "user", content: "Hi" }], [], signal, { maxTokens: 1 })) void event
    return !signal.aborted
  } catch {
    return false
  }
}

export const monthOf = (now = new Date()) => now.toISOString().slice(0, 7)

/** One row per user, month and `personal`, so adding waits on a lock for that row */
export async function recordUsage(userId: string, organizationId: string, tokens: number, personal: boolean): Promise<void> {
  const add = Math.round(tokens)
  if (!(add > 0)) return
  const month = monthOf()
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai-usage:${organizationId}:${userId}:${month}:${personal}`}, 0))`)
    const [row] = await tx
      .select({ id: aiUsage.id })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.organizationId, organizationId),
          eq(aiUsage.userId, userId),
          eq(aiUsage.month, month),
          eq(aiUsage.personal, personal),
        ),
      )
      .limit(1)
    if (row) {
      await tx
        .update(aiUsage)
        .set({ tokens: sql`${aiUsage.tokens} + ${add}` })
        .where(and(eq(aiUsage.id, row.id), eq(aiUsage.organizationId, organizationId)))
    } else {
      await tx.insert(aiUsage).values({ organizationId, userId, month, tokens: add, personal })
    }
  })
}

/** Tokens counted against the budgets this month. Usage on a personal key or address isn't counted */
export async function usedThisMonth(organizationId: string, userId?: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string | null>`sum(${aiUsage.tokens})` })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.organizationId, organizationId),
        eq(aiUsage.month, monthOf()),
        eq(aiUsage.personal, false),
        userId ? eq(aiUsage.userId, userId) : undefined,
      ),
    )
  return Number(row?.total ?? 0)
}
