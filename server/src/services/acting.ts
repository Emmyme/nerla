import { randomBytes } from "node:crypto"
import { Socket } from "node:net"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Via } from "../utils/aiTypes"
import { UUID } from "../utils/uuid"

const ACT_HEADER = "x-nerla-act"

/** Every route a tool reaches, as the method and the route's own pattern. Each `:param` must be a UUID. Never a delete for good, a folder or a project delete */
const ACT_ALLOWED = [
  "GET /api/tasks/user",
  "GET /api/tasks/project/:projectId",
  "GET /api/tasks/:id",
  "GET /api/tasks/:taskId/comments",
  "POST /api/tasks/:taskId/comments",
  "POST /api/tasks",
  "PUT /api/tasks/:id",
  "DELETE /api/tasks/:id",
  "POST /api/tasks/:id/restore",
  "GET /api/projects/all",
  "GET /api/projects/:id",
  "GET /api/projects/:projectId/members",
  "POST /api/projects",
  "POST /api/projects/:id/restore",
  "GET /api/calendar/range",
  "GET /api/calendar/free",
  "GET /api/calendar/:id",
  "POST /api/calendar",
  "PUT /api/calendar/:id",
  "DELETE /api/calendar/:id",
  "POST /api/calendar/:id/restore",
  "GET /api/papers/:id/comments",
  "POST /api/papers/:id/comments",
  "POST /api/papers",
  "GET /api/chats",
  "GET /api/group-chats/:id/messages",
  "POST /api/group-chats/:id/messages",
  "GET /api/messages/conversation/:contactId",
  "POST /api/messages",
  "GET /api/files/search",
  "GET /api/files/:id",
  "POST /api/files/:id/grants",
  "DELETE /api/files/:id",
  "POST /api/files/:id/restore",
  "GET /api/trash",
  "POST /api/time/entries",
  "GET /api/users/search",
] as const

const trimSlash = (path: string) => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path)

const RULES = ACT_ALLOWED.map((rule) => {
  const [method, pattern] = rule.split(" ")
  return { method, pattern, parts: pattern.split("/") }
})

/** Whether an act token may call this path */
export function actAllowed(method: string, path: string): boolean {
  const parts = trimSlash(path).split("/")
  return RULES.some(
    (rule) =>
      rule.method === method &&
      rule.parts.length === parts.length &&
      rule.parts.every((part, i) => (part.startsWith(":") ? UUID.test(parts[i]) : part === parts[i])),
  )
}

/** The route Fastify matched must be one of the rules itself, so a pattern never stands in for a sibling route */
const routeAllowed = (method: string, routeUrl: string | undefined) =>
  !!routeUrl && RULES.some((rule) => rule.method === method && rule.pattern === trimSlash(routeUrl))

type Act = { userId: string; organizationId: string; via: Via }

/** Live act tokens, held in memory only while one call runs */
const acts = new Map<string, Act>()

function actAs(asker: { id: string; organizationId: string }, via: Via): { token: string; done(): void } {
  const token = randomBytes(32).toString("hex")
  acts.set(token, { userId: asker.id, organizationId: asker.organizationId, via })
  return { token, done: () => void acts.delete(token) }
}

/**
 * Made by `app.inject`. A request from the network always arrives on a real socket. Relies on light-my-request's
 * `_lightMyRequest` marker, so a change there fails closed and no act token works
 */
function injected(request: FastifyRequest): boolean {
  const raw = request.raw as FastifyRequest["raw"] & { _lightMyRequest?: unknown }
  return raw._lightMyRequest !== undefined && !(raw.socket instanceof Socket)
}

export const hasActHeader = (request: FastifyRequest) => request.headers[ACT_HEADER] !== undefined

/** The act behind the request, never for one that came over the network */
export function actOf(request: FastifyRequest): Act | null {
  const token = request.headers[ACT_HEADER]
  if (typeof token !== "string" || !injected(request)) return null
  return acts.get(token) ?? null
}

/** Runs before every route. An act header from the network or with a dead token is refused, and so is any route off the list */
export async function actGate(request: FastifyRequest, reply: FastifyReply) {
  if (!hasActHeader(request)) return
  if (!actOf(request)) return reply.code(401).send({ error: "Invalid or expired token." })
  const path = request.url.split("?")[0]
  if (!actAllowed(request.method, path) || !routeAllowed(request.method, request.routeOptions.url)) {
    return reply.code(404).send({ error: "Not found" })
  }
}

let app: FastifyInstance | null = null

export function bindActing(instance: FastifyInstance): void {
  app = instance
}

export type AppRequest = { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; body?: unknown }

async function callApp(token: string, req: AppRequest): Promise<{ status: number; body: unknown }> {
  if (!app) throw new Error("Acting is not bound to the app")
  const res = await app.inject({
    method: req.method,
    url: req.url,
    headers: { [ACT_HEADER]: token },
    ...(req.body === undefined ? {} : { payload: req.body as object }),
  })
  let body: unknown = null
  try {
    body = res.payload ? JSON.parse(res.payload) : null
  } catch {
    body = null
  }
  return { status: res.statusCode, body }
}

/** A refusal from the app's own route, with its status */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A route's refusal in plain words, with the fields it named, so a model can fix its input */
export function errorOf(status: number, body: unknown): string {
  const { error, details } = (body ?? {}) as { error?: unknown; details?: { fieldErrors?: unknown; formErrors?: unknown } }
  if (status >= 500 || typeof error !== "string") return "Something went wrong"
  const words = (messages: unknown) =>
    Array.isArray(messages) ? messages.filter((message): message is string => typeof message === "string") : []
  const fields =
    details?.fieldErrors && typeof details.fieldErrors === "object" ? Object.entries(details.fieldErrors as Record<string, unknown>) : []
  const said = [
    ...words(details?.formErrors).map((message) => message.slice(0, 200)),
    ...fields.flatMap(([field, messages]) => {
      const list = words(messages)
      return list.length ? [`${field.slice(0, 60)}: ${list.join(", ").slice(0, 200)}`] : []
    }),
  ]
  return said.length ? `${error}: ${said.slice(0, 10).join(". ")}` : error
}

/** One route call as the asker, with its own act token. A refusal throws `AppError` */
export async function callAs<T = unknown>(asker: { id: string; organizationId: string }, via: Via, req: AppRequest): Promise<T> {
  const act = actAs(asker, via)
  try {
    const res = await callApp(act.token, req)
    if (res.status >= 400) throw new AppError(res.status, errorOf(res.status, res.body))
    return res.body as T
  } finally {
    act.done()
  }
}
