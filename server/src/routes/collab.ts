import type { FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocketLike } from "@hocuspocus/server"
import { attachCollab, closeCollab, openCollabSocket } from "../services/collab"
import { resumeShareTimers } from "../services/docCalls"
import { logger } from "../utils/logger"
import { errorText } from "../utils/errorText"

type RawSocket = {
  send: (data: Uint8Array) => void
  close: (code?: number, reason?: string) => void
  on(event: "message", handler: (data: RawData, isBinary: boolean) => void): void
  on(event: "pong", handler: () => void): void
  on(event: "close", handler: (code: number, reason: Buffer) => void): void
  on(event: "error", handler: (error: Error) => void): void
  readyState: number
}

type RawData = Buffer | ArrayBuffer | Buffer[]

const bytesOf = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/** The upgrade as a fetch Request, which the live server reads the cookie and query from */
function requestOf(req: FastifyRequest): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(", ") : value)
  }
  return new Request(new URL(req.url, "http://localhost"), { headers })
}

/** Papers and boards live at `/ws/collab`, on the websocket plugin that already owns the upgrade */
export function registerCollab(app: FastifyInstance) {
  attachCollab(app)
  resumeShareTimers().catch((error) => logger.warn("Resuming call share timers failed", { error: errorText(error) }))

  app.get("/ws/collab", { websocket: true }, (socket: RawSocket, req: FastifyRequest) => {
    const like: WebSocketLike = {
      send: (data) => socket.send(data as Uint8Array),
      close: (code, reason) => socket.close(code, reason),
      get readyState() {
        return socket.readyState
      },
    }
    const connection = openCollabSocket(like, requestOf(req), req.host)
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) connection.handleMessage(bytesOf(data))
    })
    socket.on("pong", () => connection.touch())
    socket.on("close", (code: number, reason: Buffer) => connection.handleClose({ code, reason: reason.toString() }))
    socket.on("error", (error: Error) => logger.warn("A live doc socket failed", { error: error.message }))
  })

  app.addHook("onClose", async () => {
    await closeCollab()
  })
}
