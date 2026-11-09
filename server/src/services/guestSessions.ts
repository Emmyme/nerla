import crypto from "crypto"
import { and, asc, eq, gte, lt } from "drizzle-orm"
import { db, guestSessions } from "../db"

type GuestSession = typeof guestSessions.$inferSelect

const PENDING_TTL_MS = 10 * 60 * 1000
const RESOLVED_TTL_MS = 60 * 1000

const hashSecret = (secret: string) => crypto.createHash("sha256").update(secret).digest()
const expiry = (ttl: number) => new Date(Date.now() + ttl)

/** The new session plus its secret, which goes to the guest once and is never stored */
export async function createGuestSession(name: string, roomName: string): Promise<GuestSession & { secret: string }> {
  const secret = crypto.randomBytes(32).toString("hex")
  const [session] = await db
    .insert(guestSessions)
    .values({
      id: crypto.randomBytes(16).toString("hex"),
      name,
      roomName,
      status: "pending",
      secretHash: hashSecret(secret),
      expiresAt: expiry(PENDING_TTL_MS),
    })
    .returning()
  return { ...session, secret }
}

const secretMatches = (session: GuestSession | undefined, secret: unknown) =>
  !!session && typeof secret === "string" && secret.length === 64 && crypto.timingSafeEqual(hashSecret(secret), session.secretHash)

export async function guestSecretMatches(id: string, secret: unknown): Promise<boolean> {
  return secretMatches(await getGuestSession(id), secret)
}

export async function getGuestSession(id: string): Promise<GuestSession | undefined> {
  return db.query.guestSessions.findFirst({ where: eq(guestSessions.id, id) })
}

/** Moves a pending session on, in one statement so two processes never both resolve it */
async function resolve(id: string, values: Partial<GuestSession>): Promise<GuestSession | undefined> {
  const [session] = await db
    .update(guestSessions)
    .set({ ...values, expiresAt: expiry(RESOLVED_TTL_MS) })
    .where(and(eq(guestSessions.id, id), eq(guestSessions.status, "pending")))
    .returning()
  return session
}

export async function admitGuest(id: string, token: string, identity: string): Promise<boolean> {
  return !!(await resolve(id, { status: "admitted", token, identity }))
}

/** The admitted guest's token, handed out once so no one else can read it from the status endpoint later */
export async function takeGuestToken(id: string, secret: unknown): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(guestSessions).where(eq(guestSessions.id, id)).for("update")
    if (!session || session.status !== "admitted" || !session.token || !secretMatches(session, secret)) return null
    await tx.update(guestSessions).set({ token: null }).where(eq(guestSessions.id, id))
    return session.token
  })
}

export async function denyGuest(id: string): Promise<boolean> {
  return !!(await resolve(id, { status: "denied" }))
}

/** The guest gave up waiting. Returns the room to tell its hosts, or null when there was nothing to cancel */
export async function cancelGuest(id: string, secret: unknown): Promise<string | null> {
  if (!(await guestSecretMatches(id, secret))) return null
  return (await resolve(id, { status: "cancelled" }))?.roomName ?? null
}

export async function pendingFor(roomName: string, now = Date.now()): Promise<{ sessionId: string; guestName: string }[]> {
  return db
    .select({ sessionId: guestSessions.id, guestName: guestSessions.name })
    .from(guestSessions)
    .where(and(eq(guestSessions.roomName, roomName), eq(guestSessions.status, "pending"), gte(guestSessions.expiresAt, new Date(now))))
    .orderBy(asc(guestSessions.expiresAt))
}

/** The guest-sessions schedule drops sessions whose time is up */
export async function pruneGuestSessions(): Promise<void> {
  await db.delete(guestSessions).where(lt(guestSessions.expiresAt, new Date()))
}
