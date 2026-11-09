import { FastifyRequest, FastifyReply } from "fastify"
import { eq } from "drizzle-orm"
import { db, users } from "../db"
import { COOKIE_NAME } from "../utils/authCookie"
import { verifyAuthToken } from "../services/sessions"
import { actOf, hasActHeader } from "../services/acting"
import { isMemberOf } from "../services/tenancy"

const BEARER = "Bearer "

/** The token of a Bearer Authorization header, undefined when there is none or it is empty */
export function bearerOf(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  return header?.startsWith(BEARER) ? header.slice(BEARER.length).trim() || undefined : undefined
}

export function extractAuthToken(request: FastifyRequest): string | undefined {
  // The desktop app sends a Bearer header, the website an HttpOnly cookie
  return request.headers.authorization?.startsWith(BEARER) ? bearerOf(request) : request.cookies?.[COOKIE_NAME]
}

/** A tool call acting as the asker, who is looked up again so a removed account stops at once */
async function actAuth(request: FastifyRequest, reply: FastifyReply) {
  const act = actOf(request)
  const user = act
    ? await db.query.users.findFirst({
        where: eq(users.id, act.userId),
        columns: { id: true, email: true, role: true, tokenVersion: true },
      })
    : null
  if (!act || !user || !(await isMemberOf(user.id, act.organizationId))) {
    return reply.status(401).send({ error: "Invalid or expired token." })
  }
  request.user = { id: user.id, email: user.email, role: user.role, tv: user.tokenVersion }
  request.via = act.via
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  if (hasActHeader(request)) return actAuth(request, reply)

  const token = extractAuthToken(request)

  if (!token) {
    return reply.status(401).send({ error: "Access denied. No token provided." })
  }

  const session = await verifyAuthToken(request.server, token)

  if (!session) {
    return reply.status(401).send({ error: "Invalid or expired token." })
  }

  request.user = session
}
