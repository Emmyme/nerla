/**
 * Tokens revoked at logout. Stored in the database so revocations survive a
 * restart and apply across instances
 */

import { db, tokenBlacklist } from "../db"
import { eq, lte } from "drizzle-orm"

/** Matches the session token's own 7 day lifetime */
const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

/** The hourly revoked-tokens job. Deletes revocations past their token's own expiry, which no longer matter */
export async function pruneRevokedTokens(): Promise<void> {
  await db.delete(tokenBlacklist).where(lte(tokenBlacklist.expiresAt, new Date().toISOString()))
}

export async function blacklistToken(token: string, expiresInMs = TOKEN_LIFETIME_MS): Promise<void> {
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString()
  await db.insert(tokenBlacklist).values({ token, expiresAt }).onConflictDoNothing()
}

/** Fails closed, so an unreachable database rejects the token */
export async function isTokenBlacklisted(token: string): Promise<boolean> {
  try {
    const entry = await db.query.tokenBlacklist.findFirst({
      where: eq(tokenBlacklist.token, token),
    })
    return !!entry
  } catch {
    return true
  }
}
