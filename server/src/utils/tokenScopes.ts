import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { ToolArea } from "./aiTypes"
import { serverInstant } from "./chatAccess"

export const TOKEN_PREFIX = "nerla_pat_"

/** The areas the user picks per token. `people` comes with any of them */
export const TOKEN_AREAS = ["tasks", "projects", "calendar", "papers", "chat", "files", "time"] as const

type TokenAreas = Partial<Record<ToolArea, "read" | "write">>
type TokenState = { scopes: TokenAreas; readOnly: boolean; expiresAt: string | null; revokedAt: string | null }

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex")

export function newToken(): { token: string; hash: string; last4: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`
  return { token, hash: hashToken(token), last4: token.slice(-4) }
}

/** Two sha256 hex hashes compared in constant time */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right)
}

/** Not revoked and not past its expiry */
export function tokenLive(token: Pick<TokenState, "expiresAt" | "revokedAt">, now: Date): boolean {
  if (token.revokedAt) return false
  return token.expiresAt === null || serverInstant(token.expiresAt) > now.getTime()
}

export function tokenAllows(token: TokenState, area: ToolArea, write: boolean, now: Date): boolean {
  if (!tokenLive(token, now)) return false
  if (write && token.readOnly) return false
  const levels = TOKEN_AREAS.map((name) => token.scopes[name]).filter((level) => level === "read" || level === "write")
  if (area === "people") return levels.length > 0 && !write
  const level = token.scopes[area]
  return write ? level === "write" : level === "read" || level === "write"
}
