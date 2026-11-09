import { eq } from "drizzle-orm"
import type { FastifyInstance, InjectOptions } from "fastify"
import { db, users } from "../db"
import { signAuthToken } from "../services/sessions"

process.env.JWT_SECRET ||= "nerla-test-secret-that-is-long-enough-0123456789"
process.env.LOG_LEVEL ||= "error"

/** The server's own app, with every route and hook, for `app.inject` */
export async function testApp(): Promise<FastifyInstance> {
  const { buildApp } = await import("../app")
  const app = await buildApp()
  await app.ready()
  return app
}

/** Headers that sign the request in as the user, with a fresh session token */
export async function signedIn(app: FastifyInstance, userId: string): Promise<{ authorization: string }> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) })
  if (!user) throw new Error(`No user ${userId}`)
  return { authorization: `Bearer ${signAuthToken(app, user)}` }
}

let address = 0

/** Requests as the user, each from its own address so the per-address rate limit never trips a test */
export function caller(app: FastifyInstance, userId: string) {
  let headers: { authorization: string } | undefined
  return async (method: InjectOptions["method"], url: string, payload?: InjectOptions["payload"]) => {
    headers ??= await signedIn(app, userId)
    address++
    return app.inject({ method, url, headers, payload, remoteAddress: `10.0.${(address >> 8) & 255}.${address & 255}` })
  }
}
