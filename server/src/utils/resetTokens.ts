/** Emailed in the clear, stored hashed, so a database read is not enough. */

import crypto from "crypto"
import { hashToken, sameHash } from "./tokenScopes"

export function generateResetToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("hex")
  return { token, hash: hashToken(token) }
}

export function resetTokenMatches(candidate: string, storedHash: string | null): boolean {
  return !!storedHash && sameHash(storedHash, hashToken(candidate))
}

/**
 * These columns hold UTC but carry no zone, so `new Date()` would read them as
 * local time and expire every token in any zone ahead of UTC.
 */
export function isResetTokenExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(expiresAt)
  const parsed = new Date(hasZone ? expiresAt : `${expiresAt.replace(" ", "T")}Z`)
  return Number.isNaN(parsed.getTime()) || parsed <= new Date()
}
