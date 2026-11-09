import fastify, { type FastifyRequest } from "fastify"
import { errorHandler } from "./middleware/errorHandler"
import { handleWebSocket } from "./services/websocket"
import { registerCollab } from "./routes/collab"
import { uploadCeiling } from "./utils/storageCaps"
import { actGate, actOf, bindActing } from "./services/acting"
import { closeMcpSessions } from "./services/mcp"
import { COOKIE_NAME, cookieOriginAllowed } from "./utils/authCookie"
import { resolveTrustProxy } from "./utils/trustProxy"
import { DESKTOP_ORIGINS } from "./utils/clientUrl"

export async function buildApp() {
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      serializers: {
        // A query string can hold a token, so the log keeps only the path
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: request.url.split("?")[0],
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        }),
      },
    },
    trustProxy: resolveTrustProxy(),
  })

  await app.register(import("@fastify/helmet"))
  // Responses only. No client sends compressed bodies, and decoding them would expose zlib to unauthenticated input.
  await app.register(import("@fastify/compress"), { globalDecompression: false })
  const corsOrigins = [...DESKTOP_ORIGINS]
  if (process.env.CLIENT_URL) {
    corsOrigins.unshift(process.env.CLIENT_URL)
  }
  if (process.env.NODE_ENV !== "production") {
    // Vite dev server, serves both the web app and `tauri dev`.
    corsOrigins.push("http://localhost:3001", "http://127.0.0.1:3001")
  }
  await app.register(import("@fastify/cors"), {
    origin: corsOrigins,
    credentials: true,
    // @fastify/cors otherwise defaults to GET,HEAD,POST only.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Nerla-Client", "X-Guest-Secret", "X-Doc-Token", "X-Nerla-Known"],
    // Lets the desktop app and a split-origin site read how long a 429 asks them to wait
    exposedHeaders: ["Retry-After"],
  })
  // Before sign-in the limit is per address and only catches floods. Once signed in it is per user, higher for reads than writes.
  // A tool call acting as the asker comes from inside the server and is capped by the AI's own limits instead.
  // RATE_LIMIT_MAX lets the e2e browsers, all on 127.0.0.1, share higher limits. Only a test server reads it
  const testMax = process.env.NODE_ENV === "test" ? Number(process.env.RATE_LIMIT_MAX) : NaN
  const scaled = Number.isInteger(testMax) && testMax > 0
  const addressMax = scaled ? testMax : 600
  const readMax = scaled ? Math.ceil(testMax / 2) : 600
  const writeMax = scaled ? Math.ceil(testMax / 5) : 120
  // shortcut: counters are per process, so N processes allow up to N times the budget, move to a shared store when running more than one
  await app.register(import("@fastify/rate-limit"), {
    max: addressMax,
    timeWindow: "1 minute",
    allowList: (request) => actOf(request) !== null,
  })
  const userLimits = {
    read: app.createRateLimit({ max: readMax, timeWindow: "1 minute", keyGenerator: (request) => request.user.id }),
    write: app.createRateLimit({ max: writeMax, timeWindow: "1 minute", keyGenerator: (request) => request.user.id }),
  }
  // Appended to every route's own hooks, so it runs after the auth hooks and only counts requests that signed in
  app.addHook("onRoute", (route) => {
    route.preHandler = [
      ...[route.preHandler ?? []].flat(),
      async (request, reply) => {
        if (!request.user?.id || actOf(request) !== null) return
        const reads = request.method === "GET" || request.method === "HEAD"
        const limit = await userLimits[reads ? "read" : "write"](request)
        if (limit.isAllowed || !limit.isExceeded) return
        return reply
          .code(429)
          .header("retry-after", String(limit.ttlInSeconds))
          .send({ error: "You're going too fast, so Nerla paused you. Wait a moment and try again." })
      },
    ]
  })
  app.addHook("onRequest", actGate)
  bindActing(app)
  await app.register(import("@fastify/jwt"), {
    secret: process.env.JWT_SECRET!,
  })
  await app.register(import("@fastify/cookie"))
  // The strict SameSite cookie still comes from sibling ports and subdomains, so a cookie write counts only from Nerla's own pages
  app.addHook("onRequest", async (request, reply) => {
    // Only a Bearer token takes the cookie's place (extractAuthToken), so any other Authorization header still gets checked
    if (
      ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
      request.headers.authorization?.startsWith("Bearer ") ||
      !request.cookies[COOKIE_NAME]
    )
      return
    if (!cookieOriginAllowed(request.headers.origin, request.host)) {
      return reply.code(403).send({ error: "This request came from another site, so it was refused." })
    }
  })

  await app.register(import("@fastify/multipart"), {
    limits: {
      fileSize: uploadCeiling(),
      files: 1,
    },
  })

  // 16 MiB, far above the largest stored doc state (about 3 KB when measured), so a large board's first sync still loads
  await app.register(import("@fastify/websocket"), { options: { maxPayload: 16 * 1024 * 1024 } })
  app.get("/ws", { websocket: true }, handleWebSocket)
  registerCollab(app)

  app.setErrorHandler(errorHandler)

  // Routes load here, after the env check in start()
  app.register(import("./routes/health"))
  app.register(import("./routes/auth"), { prefix: "/api/auth" })
  app.register(import("./routes/users"), { prefix: "/api/users" })
  app.register(import("./routes/organizations"), {
    prefix: "/api/organizations",
  })
  app.register(import("./routes/projects"), { prefix: "/api/projects" })
  app.register(import("./routes/tasks"), { prefix: "/api/tasks" })
  app.register(import("./routes/messages"), { prefix: "/api/messages" })
  app.register(import("./routes/calendar"), { prefix: "/api/calendar" })
  app.register(import("./routes/calendarSharing"), { prefix: "/api/calendar/sharing" })
  app.register(import("./routes/groupChats"), { prefix: "/api/group-chats" })
  app.register(import("./routes/chats"), { prefix: "/api/chats" })
  app.register(import("./routes/files"), { prefix: "/api/files" })
  app.register(import("./routes/fileBrowser"), { prefix: "/api/files" })
  app.register(import("./routes/fileSharing"), { prefix: "/api/files" })
  app.register(import("./routes/publicLinks"), { prefix: "/api/public/links" })
  app.register(import("./routes/papers"), { prefix: "/api/papers" })
  app.register(import("./routes/meetings"), { prefix: "/api/meetings" })
  app.register(import("./routes/presence"), { prefix: "/api/presence" })
  app.register(import("./routes/search"), { prefix: "/api/search" })
  app.register(import("./routes/trash"), { prefix: "/api/trash" })
  app.register(import("./routes/notifications"), { prefix: "/api/notifications" })
  app.register(import("./routes/time"), { prefix: "/api/time" })
  app.register(import("./routes/ai"), { prefix: "/api/ai" })
  app.register(import("./routes/aiTokens"), { prefix: "/api/ai/tokens" })
  app.register(import("./routes/setup"), { prefix: "/api/setup" })
  app.register(import("./routes/mcp"), { prefix: "/mcp" })
  // On the root, since a preClose hook inside a prefixed plugin stalls the close
  app.addHook("preClose", closeMcpSessions)

  return app
}
