/**
 * Every token carries the issuing user's `tokenVersion`. Bumping that column
 * invalidates all of their outstanding tokens at once
 */

import { randomUUID } from "node:crypto"
import { FastifyInstance } from "fastify"
import { eq, sql } from "drizzle-orm"
import { db, users } from "../db"
import { isTokenBlacklisted } from "./tokenBlacklist"
import { TOKEN_PREFIX } from "../utils/tokenScopes"

const TOKEN_TTL = "7d"

interface SessionUser {
  id: string
  email: string
  role: string
  tv: number
}

interface SignableUser {
  id: string
  email: string
  role: string
  tokenVersion: number
}

export function signAuthToken(fastify: FastifyInstance, user: SignableUser): string {
  const payload: SessionUser = {
    id: user.id,
    email: user.email,
    role: user.role,
    tv: user.tokenVersion,
  }
  // A token of its own each time, so two sign-ins in the same second never share one and a sign-out ends only its own
  return fastify.jwt.sign(payload, { expiresIn: TOKEN_TTL, jti: randomUUID() })
}

export async function revokeUserSessions(userId: string): Promise<number> {
  const [updated] = await db
    .update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, userId))
    .returning({ tokenVersion: users.tokenVersion })
  return updated?.tokenVersion ?? 0
}

/**
 * Checks signature, revocation list and token version together, returning null
 * on any failure so a partially checked token is never treated as valid
 */
export async function verifyAuthToken(fastify: FastifyInstance, token: string): Promise<SessionUser | null> {
  // An agent's access token works only at /mcp
  if (token.startsWith(TOKEN_PREFIX)) return null
  let payload: SessionUser
  try {
    payload = fastify.jwt.verify<SessionUser>(token)
  } catch {
    return null
  }

  if (typeof payload?.id !== "string" || typeof payload.email !== "string" || typeof payload.tv !== "number") {
    return null
  }

  if (await isTokenBlacklisted(token)) {
    return null
  }

  const current = await db.query.users.findFirst({
    where: eq(users.id, payload.id),
    columns: { tokenVersion: true },
  })

  if (!current || current.tokenVersion !== payload.tv) {
    return null
  }

  return payload
}
