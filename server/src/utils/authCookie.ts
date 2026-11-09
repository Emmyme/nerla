import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto"
import type { FastifyReply, FastifyRequest } from "fastify"
import { CLIENT_URL } from "./clientUrl"

const COOKIE_NAME = "nerla_jwt"
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60 // 7 days, matches JWT expiry
const KNOWN_NAME = "nerla_known"
const KNOWN_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

// The key is derived on each use, since JWT_SECRET may come from its file after this module loads. The password hash
// is in the mark, so changing or resetting the password ends every browser's mark
const knownMark = (email: string, passwordHash: string) =>
  createHmac("sha256", Buffer.from(hkdfSync("sha256", process.env.JWT_SECRET!, "", "nerla known device", 32)))
    .update(`${email.trim().toLowerCase()}|${passwordHash}`)
    .digest("base64url")
    .slice(0, 22)

/** The browser keeps its marks in a cookie. The desktop app keeps them in its store and sends them in a header */
const knownMarks = (request: FastifyRequest) => {
  const header = request.headers["x-nerla-known"]
  return (request.cookies?.[KNOWN_NAME] ?? (typeof header === "string" ? header : "")).split(",").filter(Boolean).slice(0, 5)
}

/** Whether this browser signed in to this email since its password last changed. Only the server can make the mark, and it holds no email */
export function isKnownDevice(request: FastifyRequest, email: string, passwordHash: string | null | undefined): boolean {
  if (!passwordHash) return false
  const mark = Buffer.from(knownMark(email, passwordHash))
  return knownMarks(request).some((seen) => seen.length === mark.length && timingSafeEqual(Buffer.from(seen), mark))
}

/** Remembers a good sign-in for a year, for the 5 most recent emails. Signing out keeps it. Gives the marks for the desktop app to keep */
export function rememberDevice(request: FastifyRequest, reply: FastifyReply, email: string, passwordHash: string): string {
  const mark = knownMark(email, passwordHash)
  const marks = [mark, ...knownMarks(request).filter((seen) => seen !== mark)].slice(0, 5).join(",")
  reply.setCookie(KNOWN_NAME, marks, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/auth",
    maxAge: KNOWN_MAX_AGE_SECONDS,
  })
  return marks
}

export function setAuthCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  })
}

export function clearAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
  })
}

/** The Vite dev server, which CORS also lets in outside production */
const DEV_ORIGINS = ["http://localhost:3001", "http://127.0.0.1:3001"]

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Whether the origin names the host and port the request went to, as its Host header or a trusted proxy says */
function sameHost(origin: string, host: string | null | undefined): boolean {
  if (!host) return false
  try {
    const page = new URL(origin)
    return new URL(`${page.protocol}//${host}`).host === page.host
  } catch {
    return false
  }
}

/**
 * Whether a socket the cookie signs in comes from Nerla's own website: a page on the host the socket was opened on,
 * which covers any address a self-hoster serves Nerla at, or CLIENT_URL. A browser sends the cookie from any page on
 * the same site, so a sibling page could otherwise open a socket as the user
 */
export function cookieOriginAllowed(origin: string | null | undefined, host?: string | null): boolean {
  if (!origin) return false
  if (origin === originOf(CLIENT_URL) || sameHost(origin, host)) return true
  return process.env.NODE_ENV !== "production" && DEV_ORIGINS.includes(origin)
}

export { COOKIE_NAME }
