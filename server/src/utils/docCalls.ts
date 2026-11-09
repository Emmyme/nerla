import { createHmac, timingSafeEqual } from "node:crypto"
import { storedMs } from "./eventTime"
import { localDate } from "./timeRules"
import { UUID } from "./uuid"

/** A guest's doc token and call pass last this long, and the client refreshes them well before */
const GUEST_DOC_TTL_S = 10 * 60
export const GUEST_IDENTITY_PREFIX = "guest-"

export type GuestDocClaims = { shareId: string; fileId: string; identity: string; name: string }
/** What an admitted guest's call pass proves: who they are in which room */
type CallGuestClaims = { roomName: string; identity: string; name: string }

const DOC_TYP = "doc-guest"
const PASS_TYP = "call-guest"
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
const HEADER = part({ alg: "HS256", typ: "JWT" })
const mac = (data: string, key: string) => createHmac("sha256", key).update(data).digest()
const secret = () => process.env.JWT_SECRET?.trim() || null

function sign(typ: string, claims: Record<string, string>, now: Date): { token: string; expiresAt: Date } {
  const key = secret()
  if (!key) throw new Error("JWT_SECRET is not set")
  const iat = Math.floor(now.getTime() / 1000)
  const exp = iat + GUEST_DOC_TTL_S
  const body = `${HEADER}.${part({ typ, ...claims, iat, exp })}`
  return { token: `${body}.${mac(body, key).toString("base64url")}`, expiresAt: new Date(exp * 1000) }
}

/** A doc token for a guest in a call, signed with the server's secret */
export function signGuestDocToken(claims: GuestDocClaims, now: Date): { token: string; expiresAt: Date } {
  const { shareId, fileId, identity, name } = claims
  return sign(DOC_TYP, { shareId, fileId, identity, name }, now)
}

/** A call pass for an admitted guest, signed with the server's secret */
export function signCallGuestPass(claims: CallGuestClaims, now: Date): { token: string; expiresAt: Date } {
  const { roomName, identity, name } = claims
  return sign(PASS_TYP, { roomName, identity, name }, now)
}

function decoded(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The payload of a token of that kind whose signature, algorithm and expiry hold, with a guest identity and name */
function verified(typ: string, token: string, now: Date): Record<string, unknown> | null {
  const key = secret()
  const parts = token.split(".")
  if (!key || parts.length !== 3) return null
  const [header, payload, signature] = parts
  const expected = mac(`${header}.${payload}`, key)
  const given = Buffer.from(signature, "base64url")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const head = decoded(header)
  const claims = decoded(payload)
  if (head?.alg !== "HS256" || !claims || claims.typ !== typ) return null
  if (typeof claims.exp !== "number" || now.getTime() >= claims.exp * 1000) return null
  const { identity, name } = claims
  if (typeof identity !== "string" || !identity.startsWith(GUEST_IDENTITY_PREFIX) || typeof name !== "string") return null
  return claims
}

/** The claims of a guest doc token whose signature, kind and expiry all hold, else null */
export function guestDocClaims(token: string, now: Date): GuestDocClaims | null {
  const claims = verified(DOC_TYP, token, now)
  if (!claims) return null
  const { shareId, fileId, identity, name } = claims as Record<string, string>
  if (typeof shareId !== "string" || !UUID.test(shareId) || typeof fileId !== "string" || !UUID.test(fileId)) return null
  return { shareId, fileId, identity, name }
}

/** The claims of a guest's call pass whose signature, kind and expiry all hold, else null */
export function callGuestClaims(token: string, now: Date): CallGuestClaims | null {
  const claims = verified(PASS_TYP, token, now)
  if (!claims) return null
  const { roomName, identity, name } = claims as Record<string, string>
  if (typeof roomName !== "string" || !roomName || roomName.length > 128) return null
  return { roomName, identity, name }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "{event title} {d MMM yyyy}", or "Meeting {d MMM yyyy}" without an event, from a YYYY-MM-DD date */
export function meetingDocName(eventTitle: string | null, date: string): string {
  const [year, month, day] = date.split("-").map(Number)
  const title = eventTitle?.trim() || "Meeting"
  const when = `${day} ${MONTHS[month - 1]} ${year}`
  return `${[...title].slice(0, 240).join("")} ${when}`
}

/** The day a meeting doc is filed under: an all-day occurrence's own date, a timed one's start read in the event's zone */
export function eventDay(when: { date?: string; start?: string }, zone: string | null): string | null {
  if (when.start) return localDate(new Date(when.start), zone)
  return when.date ?? null
}

/** The occurrence going on at `now`, else the one starting nearest to it */
export function nearestOccurrence<T extends { startsAt: string; endsAt: string }>(occurrences: T[], now: Date): T | null {
  const at = now.getTime()
  let best: T | null = null
  let gap = Infinity
  for (const occurrence of occurrences) {
    const start = storedMs(occurrence.startsAt)
    const end = storedMs(occurrence.endsAt)
    if (start === null || end === null) continue
    const distance = start <= at && at < end ? 0 : Math.abs(start - at)
    if (distance < gap) [best, gap] = [occurrence, distance]
  }
  return best
}
